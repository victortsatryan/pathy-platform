import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  IN_FLIGHT_STATUSES, MAX_SOURCE_BYTES, PUBLISH_BATCH, REPROCESS_ROOT_STATUSES, canPublishRevision,
  canPublishWithRights, classifyUnit, effectivePublication, kindToMaterialType,
  sourceExtension, stableUnitKey,
} from "./pipeline";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { dispatchBatch } from "./actions-dispatch.server";
import { importStoredResult, ResultIntegrityError } from "./actions-large-result.server";
import { verifySourceResponse } from "./source-verification.server";
import { canonicalJson } from "./schema";
import { needsContentReview, topicBelongsToSubject } from "./topic-linking";
import { sourceUnitQuality } from "./source-sections";
import {
  REVISION_CORRECTION_VERSION, approvedRevisionText, appendCorrectionHistory,
  correctionAlreadyApplied, sha256Text,
} from "./revision-publication.server";

type Sb = SupabaseClient<Database>;
const BUCKET = "extractor-sources";
const TIMEOUT_MS = 20_000;

async function assertAdmin(sb: Sb, userId: string) {
  const { data, error } = await sb.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Доступ только администратору");
}

async function loadJob(sb: Sb, id: string) {
  const r = await sb.from("extractor_jobs").select("*").eq("id", id).single();
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

function needsSourceLinkageReview(job: Awaited<ReturnType<typeof loadJob>>) {
  const context = (job.result as any)?.pipeline_context;
  return job.worker_rule_version === "pathy-batch-v1" && (job.stage === "review_required" || (context?.mode !== "manual_audit" && context?.source_block_linkage_complete !== true));
}

// A page-less text source can still have exact source-line provenance. This is
// a review candidate, not permission to publish: publication additionally
// requires the persisted admin review, rights, approved topic and revision gate.
// Other reasons for unusability must not be overridden by a generic review.
function lineBoundReviewCandidate(job: Awaited<ReturnType<typeof loadJob>>, raw: Record<string, any>): boolean {
  const context = (job.result as any)?.pipeline_context;
  const ids = raw.source?.canonical_block_ids, blocks = raw.source?.source_blocks;
  const stage = raw.pipeline_stage;
  return job.worker_rule_version === "pathy-batch-v1" && !needsSourceLinkageReview(job)
    && context?.source_original_bytes_verified === true && context?.source_sha256 === job.file_sha256
    && raw.role === "student_material" && raw.source?.sha256 === job.file_sha256
    && raw.usable_for_learning === false && raw.requires_manual_review === true
    && raw.review_status === "needs_review" && Array.isArray(raw.review_reasons)
    && raw.review_reasons.length === 1 && raw.review_reasons[0] === "source_page_unavailable"
    && Array.isArray(ids) && ids.length > 0 && ids.every((id: unknown) => typeof id === "string" && !!id.trim()) && new Set(ids).size === ids.length
    && Array.isArray(blocks) && blocks.length === ids.length
    && blocks.every((block: any, index: number) => block?.block_id === ids[index]
      && Number.isSafeInteger(block?.source?.line) && block.source.line > 0)
    && stage?.status === "source_bound_not_production_verified"
    && Array.isArray(stage.source_block_ids) && canonicalJson(stage.source_block_ids) === canonicalJson(ids)
    && Array.isArray(stage.source_locator_statuses) && stage.source_locator_statuses.length === ids.length
    && stage.source_locator_statuses.every((status: unknown) => status === "exact");
}

async function update(sb: Sb, id: string, patch: Database["public"]["Tables"]["extractor_jobs"]["Update"]) {
  const r = await supabaseAdmin.from("extractor_jobs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (r.error) throw new Error(r.error.message);
}

/** Queue only through the bounded GitHub Actions path. */
async function dispatch(sb: Sb, id: string, userId: string) {
  try { await dispatchBatch(id, userId); }
  catch (error) {
    // A dispatch timeout may still have created a run. Never undo a reserved
    // job or automatically start a second one.
    const result = await supabaseAdmin.from("extractor_jobs").update({ status: "worker_not_configured", error: "Пакетная обработка ожидает настройки, проверки лимита или истечения резерва", updated_at: new Date().toISOString() }).eq("id", id).eq("status", "uploaded");
    if (result.error) throw new Error(result.error.message);
    throw error;
  }
}

export const getExtractorJobs = createServerFn({ method: "GET" }).middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const [jobs, subjects, topics] = await Promise.all([
      context.supabase.from("extractor_jobs").select("id,file_name,file_sha256,size_bytes,status,stage,progress,error,author,rights_basis,subject_id,created_at,updated_at,publish_report,result_total_units,revision,parent_job_id,worker_rule_version,batch_storage,batch_lease_until").order("created_at", { ascending: false }).limit(50),
      context.supabase.from("subjects").select("id,name").eq("is_public", true).order("name"),
      context.supabase.from("topics").select("id,title,subject_id").order("sort_order").limit(2000),
    ]);
    if (jobs.error) throw new Error(jobs.error.message);
    const ready = process.env.PATHY_ACTIONS_COST_APPROVED === "true" && z.string().uuid().safeParse(process.env.PATHY_ACTIONS_APPROVED_JOB_ID).success && !!process.env.PATHY_ACTIONS_DISPATCH_TOKEN && z.string().uuid().safeParse(process.env.PATHY_ACTIONS_APPROVAL_ID).success && /^[0-9a-f]{40}$/.test(process.env.PATHY_ACTIONS_CODE_SHA ?? "") && /^\d+$/.test(process.env.PATHY_ACTIONS_REPOSITORY_ID ?? "");
    return { jobs: jobs.data ?? [], subjects: subjects.data ?? [], topics: topics.data ?? [], workerConfigured: ready };
  });

export const registerExtractorUpload = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({
    storage_path: z.string().min(1).max(500), file_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    file_name: z.string().min(1).max(300), mime_type: z.string().max(200).nullable(),
    subject_id: z.string().uuid().nullable(), author: z.string().trim().max(300).nullable(),
  }).parse(v))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    await assertAdmin(sb, context.userId);
    const ext = sourceExtension(data.file_name);
    if (!ext) throw new Error("Неподдерживаемый тип файла");
    if (!data.storage_path.startsWith(`${data.file_sha256}/`)) throw new Error("Путь файла не соответствует SHA-256");
    // Verify the actual object before deduplication or any dispatch.
    const info = await sb.storage.from(BUCKET).info(data.storage_path);
    if (info.error || !info.data) throw new Error("Загруженный файл не найден: " + (info.error?.message ?? ""));
    const size = Number(info.data.size ?? 0);
    if (!size || size > MAX_SOURCE_BYTES) throw new Error("Файл пустой или больше 160 MB");
    const signed = await sb.storage.from(BUCKET).createSignedUrl(data.storage_path, 120);
    if (signed.error) throw new Error(signed.error.message);
    const source = await fetch(signed.data.signedUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    await verifySourceResponse(source, { sha256: data.file_sha256, size, extension: ext });
    // A source identity match is not permission to replace metadata or to
    // silently associate an existing source with another subject.
    const existingRoot = async () => {
      const prior = await sb.from("extractor_jobs")
        .select("id,file_name,mime_type,size_bytes,storage_path,subject_id,author")
        .eq("file_sha256", data.file_sha256).eq("revision", 1).maybeSingle();
      if (prior.error) throw new Error(prior.error.message);
      if (!prior.data) return null;
      const p = prior.data;
      if (p.file_name !== data.file_name || p.mime_type !== data.mime_type ||
          p.size_bytes !== size || p.storage_path !== data.storage_path ||
          p.subject_id !== data.subject_id || p.author !== (data.author || null)) {
        throw new Error("Конфликт источника: существующая загрузка имеет другие метаданные; данные не изменены");
      }
      return p.id;
    };
    const priorId = await existingRoot();
    if (priorId) return { id: priorId, duplicate: true };
    const ins = await supabaseAdmin.from("extractor_jobs").insert({
      file_sha256: data.file_sha256, file_name: data.file_name, mime_type: data.mime_type, size_bytes: size,
      storage_path: data.storage_path, subject_id: data.subject_id, author: data.author || null, created_by: context.userId, revision: 1,
    }).select("id").single();
    if (ins.error) {
      if (ins.error.code === "23505") {
        const again = await existingRoot();
        if (!again) throw new Error("Не удалось найти повторную загрузку");
        return { id: again, duplicate: true };
      }
      throw new Error(ins.error.message);
    }
    await dispatch(sb, ins.data.id, context.userId);
    return { id: ins.data.id, duplicate: false };
  });

export const retryExtractorJob = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const job = await loadJob(context.supabase, data.id);
    if (!["failed", "worker_not_configured", "uploaded"].includes(job.status)) throw new Error("Повтор возможен только после ошибки");
    if (job.batch_storage || (job.result as any)?.storage) throw new Error("Результат уже сохранён: используйте «Продолжить импорт»");
    await dispatch(context.supabase, data.id, context.userId);
    return { ok: true };
  });

/** Resume the already-uploaded result under a new fenced lease; never dispatch Actions. */
export const resumeExtractorImport = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const client = supabaseAdmin as any;
    let claim = await client.rpc("ext02_resume_large_result", { p_job: data.id, p_user: context.userId });
    // Earlier versions uploaded before recording object metadata. Recover only
    // one unambiguous object from the original job/run folder, then bind it
    // under the same row lock and validate its complete bytes in the importer.
    if (claim.error?.message?.includes("Saved object identity unavailable")) {
      const job = await loadJob(context.supabase, data.id);
      const oldRun = (job as any).batch_run_id;
      if (typeof oldRun !== "string" || !/^[0-9]{1,30}$/.test(oldRun)) throw new Error("Не найден однозначный сохранённый результат");
      const bucket = client.storage.from(BUCKET);
      const prefix = `ext02-results/${data.id}/${oldRun}`;
      const listing = await bucket.list(prefix, { limit: 2 });
      if (listing.error || !Array.isArray(listing.data) || listing.data.length !== 1 || !/^[0-9a-f]{64}\.json$/.test(listing.data[0]?.name ?? "")) throw new Error("Не найден однозначный сохранённый результат");
      const name = listing.data[0].name as string;
      const path = `${prefix}/${name}`;
      const info = await bucket.info(path);
      const size = Number(info.data?.size);
      if (info.error || !Number.isSafeInteger(size) || size < 1 || size > 160 * 1024 * 1024) throw new Error("Не удалось проверить сохранённый результат");
      claim = await client.rpc("ext02_resume_large_result", { p_job: data.id, p_user: context.userId, p_candidate: { path, sha256: name.slice(0, 64), size } });
    }
    if (claim.error || !claim.data) throw new Error("Не удалось продолжить импорт: задание недоступно или уже обрабатывается");
    const { run, object_run: objectRun, storage } = claim.data;
    try {
      await importStoredResult(client, data.id, run, storage.sha256, Number(storage.size), objectRun);
    } catch (error) {
      await client.rpc("ext02_fail_job", { p_job: data.id, p_run: run, p_kind: error instanceof ResultIntegrityError ? "integrity" : "technical" });
      throw new Error(error instanceof ResultIntegrityError ? "Не пройдена проверка целостности сохранённого результата" : "Не удалось продолжить импорт сохранённого результата");
    }
    return { ok: true };
  });

/**
 * Admin-only: start a NEW processing revision of an already completed source.
 * The original job, its units and its published materials are never modified.
 * The new revision is audit-only (publication is blocked in code and by a DB check).
 */
export const reprocessExtractorJob = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    await assertAdmin(sb, context.userId);
    const picked = await loadJob(sb, data.id);
    if (![...REPROCESS_ROOT_STATUSES, "failed"].includes(picked.status as any)) throw new Error("Повторная обработка доступна только для завершённых обработок");
    const root = picked.parent_job_id ? await loadJob(sb, picked.parent_job_id) : picked;
    if ((root.revision ?? 1) !== 1 || root.parent_job_id) throw new Error("Исходная обработка не найдена");
    if (root.file_sha256 !== picked.file_sha256) throw new Error("SHA-256 версии не совпадает с исходной обработкой");
    if (!(REPROCESS_ROOT_STATUSES as readonly string[]).includes(root.status)) throw new Error("Исходная обработка ещё не завершена");
    if (!root.storage_path.startsWith(`${root.file_sha256}/`)) throw new Error("Путь исходного файла не соответствует SHA-256");
    const version = "pathy-batch-v1";
    const info = await sb.storage.from(BUCKET).info(root.storage_path);
    if (info.error || !info.data) throw new Error("Исходный файл не найден в хранилище — повторная обработка не создана");
    if (Number(info.data.size ?? 0) !== Number(root.size_bytes)) throw new Error("Размер исходного файла изменился — повторная обработка не создана");
    let newId: string | null = null;
    for (let attempt = 0; attempt < 3 && !newId; attempt++) {
      const revs = await sb.from("extractor_jobs").select("id,revision,status").eq("file_sha256", root.file_sha256).order("revision", { ascending: false }).limit(50);
      if (revs.error) throw new Error(revs.error.message);
      const rows = revs.data ?? [];
      if (rows.some((r) => r.revision > 1 && (IN_FLIGHT_STATUSES as readonly string[]).includes(r.status))) {
        throw new Error("Повторная обработка этого источника уже выполняется");
      }
      const next = Math.max(1, ...rows.map((r) => r.revision)) + 1;
      const ins = await supabaseAdmin.from("extractor_jobs").insert({
        file_sha256: root.file_sha256, file_name: root.file_name, mime_type: root.mime_type, size_bytes: root.size_bytes,
        storage_path: root.storage_path, subject_id: root.subject_id, author: root.author, rights_basis: root.rights_basis,
        created_by: context.userId, revision: next, parent_job_id: root.id, worker_rule_version: version, status: "uploaded",
      }).select("id").single();
      if (ins.error) { if (ins.error.code === "23505") continue; throw new Error(ins.error.message); }
      newId = ins.data.id;
    }
    if (!newId) throw new Error("Не удалось выделить номер версии — повторите позже");
    await dispatch(sb, newId, context.userId);
    const fresh = await loadJob(sb, newId);
    return { id: newId, revision: fresh.revision, status: fresh.status, error: fresh.error, worker_rule_version: version };
  });

export const refreshExtractorJob = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    await assertAdmin(sb, context.userId);
    const job = await loadJob(sb, data.id);
    if (["queued", "processing"].includes(job.status)) {
      const expired = await (supabaseAdmin as any).rpc("ext02_expire_job", { p_job: job.id, p_user: context.userId });
      if (expired.error) throw new Error("Не удалось проверить срок обработки");
    }
    const fresh = await loadJob(sb, data.id);
    const linkageReview = needsSourceLinkageReview(fresh);
    const decisions = (fresh.unit_decisions ?? {}) as Record<string, "accept" | "reject">;
    const unitRows: any[] = [];
    for (let offset = 0; offset < 5000; offset += 500) {
      const page = await sb.from("extractor_job_units").select("unit_id,raw,publish_state,reviewed_text,review_choice,reviewed_by,reviewed_at").eq("job_id", fresh.id).order("position").range(offset, offset + 499);
      if (page.error) throw new Error(page.error.message);
      unitRows.push(...(page.data ?? []));
      if ((page.data?.length ?? 0) < 500) break;
    }
    // Reprocess revisions must expose source before/after even when the
    // legacy extractor confidently classified the unit. They never publish
    // without explicit review. Match only materials from the original job.
    const originals = fresh.revision > 1
      ? await sb.from("materials").select("id,extractor_metadata")
          .eq("extractor_metadata->>job_id", fresh.parent_job_id!).limit(5000)
      : null;
    if (originals?.error) throw new Error(originals.error.message);
    const rootMaterialByUnit = new Map<string, string>();
    for (const m of originals?.data ?? []) {
      const meta = m.extractor_metadata as Record<string, any> | null;
      if (meta?.unit_id && meta?.source_sha256 === fresh.file_sha256)
        rootMaterialByUnit.set(String(meta.unit_id), m.id);
    }
    const units = unitRows.map((r) => {
      const raw = r.raw as Record<string, any>;
      const c = classifyUnit(raw?.source?.intake_mode === "manual_audit" || lineBoundReviewCandidate(fresh, raw) ? { ...raw, usable_for_learning: true } : raw, fresh.author);
      const machine = fresh.revision > 1 && !!raw.machine_correction && c.decision !== "private" && c.decision !== "invalid";
      // A review-pending unit can be structurally ineligible for publication
      // but must still appear in the existing review UI with its explanation.
      const heldReview = c.decision === "invalid" && c.role === "student_material" && !!c.content_text && raw.requires_manual_review === true;
      const currentDecision = machine || heldReview || (fresh.worker_rule_version === "pathy-batch-v1" && c.decision === "confident") || (linkageReview && c.role === "student_material" && !!c.content_text) ? "review" as const : c.decision;
      const originalText = machine && typeof raw.original_presentation_text === "string" ? raw.original_presentation_text : null;
      return { unit_id: c.unit_id, title: c.title, kind: c.kind, pages: c.pages, role: c.role,
        decision: currentDecision, reasons: [...c.reasons, ...(heldReview ? ["Публикация заблокирована до устранения ограничений исходника или структуры"] : []), ...(machine ? ["Машинная коррекция — сверить с оригиналом"] : []), ...(linkageReview ? ["Неполная привязка к исходнику: требуется проверка полноты и сопоставления"] : []), ...((linkageReview || heldReview) && Array.isArray(raw.review_reasons) ? raw.review_reasons.map(String) : [])],
        source_evidence: linkageReview && c.role === "student_material" ? { source: raw.source, pipeline_stage: raw.pipeline_stage } : null,
        // Full text for review, including previously 'confident' machine edits.
        content_text: currentDecision === "confident" ? "" : c.content_text,
        original_content_text: originalText,
        machine_patch_count: machine ? raw.machine_correction.patches?.length ?? 0 : 0,
        machine_changes: machine && Array.isArray(raw.machine_correction.patches)
          ? raw.machine_correction.patches.map((p: Record<string, any>) => ({
              before: String(p.before ?? ""), after: String(p.after ?? ""),
              page: Number.isInteger(p.page) ? p.page : null,
              reason: String(p.reason ?? "machine_candidate"),
              source_verified: p.printed_glyph_verified === true,
            }))
          : [],
        material_id: fresh.revision > 1 ? rootMaterialByUnit.get(c.unit_id) ?? null : null,
        reviewed_text: r.reviewed_text, review_choice: r.review_choice, reviewed_at: r.reviewed_at,
        admin: decisions[c.unit_id] ?? null,
        publish: fresh.revision > 1 || linkageReview ? false : (fresh.worker_rule_version !== "pathy-batch-v1" || (!!r.reviewed_by && !!r.reviewed_at && ["keep_original", "accept_corrected"].includes(r.review_choice ?? ""))) && effectivePublication(c, r.review_choice as any, r.reviewed_text, decisions[c.unit_id]).publish,
        state: r.publish_state };
    });
    const { result: _r, ...meta } = fresh;
    return { job: meta, units, workerConfigured: false, linkageReview, linkageContext: linkageReview ? (fresh.result as any)?.pipeline_context : null, linkageEvidence: linkageReview ? (fresh.result as any)?.review_evidence : null, hasStoredEvidence: !!(fresh.result as any)?.storage?.path };
  });

export const setExtractorUnitDecision = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: z.string().uuid(), unit_id: z.string().min(1).max(500), decision: z.enum(["accept", "reject"]).nullable() }).parse(v))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const job = await loadJob(context.supabase, data.id);
    const d = { ...((job.unit_decisions ?? {}) as Record<string, string>) };
    if (data.decision) d[data.unit_id] = data.decision; else delete d[data.unit_id];
    await update(context.supabase, data.id, { unit_decisions: d });
    return { ok: true };
  });

/** Persist a human review for one unit of this job. Raw OCR (raw) is never modified. */
export const saveExtractorUnitReview = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({
    id: z.string().uuid(), unit_id: z.string().min(1).max(500),
    choice: z.enum(["accept_corrected", "keep_original", "reject"]).nullable(), reviewed_text: z.string().max(200_000).nullable(),
  }).parse(v))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    await assertAdmin(sb, context.userId);
    const job = await loadJob(sb, data.id);
    const row = await sb.from("extractor_job_units").select("id,raw,publish_state").eq("job_id", job.id).eq("unit_id", data.unit_id).maybeSingle();
    if (row.error) throw new Error(row.error.message);
    if (!row.data) throw new Error("Блок не найден в этой обработке");
    const raw = row.data.raw as Record<string, any>;
    if (raw?.source?.sha256 && raw.source.sha256 !== job.file_sha256) throw new Error("SHA блока не совпадает с источником обработки");
    const c = classifyUnit(raw, job.author);
    if (c.decision === "private") throw new Error("Материал только для учителя — публикация невозможна");
    if (row.data.publish_state === "published") throw new Error("Блок уже опубликован; опубликованные материалы не изменяются");
    const text = data.reviewed_text?.trim() ? data.reviewed_text : null;
    if (data.choice === "accept_corrected" && !text) throw new Error("Пустой исправленный текст");
    const up = await supabaseAdmin.from("extractor_job_units").update({
      reviewed_text: text, review_choice: data.choice, reviewed_by: context.userId, reviewed_at: new Date().toISOString(),
      ...(row.data.publish_state === "skipped" ? { publish_state: "pending" } : {}),
    }).eq("id", row.data.id);
    if (up.error) throw new Error(up.error.message);
    return { ok: true };
  });

/** Short-lived (5 min) signed link to the private source, admin only, never stored. */
export const getExtractorSourceLink = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: z.string().uuid(), page: z.number().int().positive().nullable() }).parse(v))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const job = await loadJob(context.supabase, data.id);
    const s = await context.supabase.storage.from(BUCKET).createSignedUrl(job.storage_path, 300);
    if (s.error || !s.data?.signedUrl) throw new Error("Не удалось открыть оригинал: " + (s.error?.message ?? ""));
    const isPdf = /\.pdf$/i.test(job.file_name);
    return { url: s.data.signedUrl + (isPdf && data.page ? `#page=${data.page}` : "") };
  });

/** Admin-only short-lived access to the private, byte-verified result and evidence. */
export const getExtractorEvidenceLink = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const job = await loadJob(context.supabase, data.id);
    const storage = (job.result as any)?.storage;
    if (!["succeeded", "publishing", "published"].includes(job.status) || typeof storage?.path !== "string" || !storage.path.startsWith(`ext02-results/${job.id}/`) || !/^[0-9a-f]{64}$/.test(storage.sha256 ?? "") || !storage.path.endsWith(`/${storage.sha256}.json`)) throw new Error("Сохранённые свидетельства недоступны");
    const link = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(storage.path, 300);
    if (link.error || !link.data?.signedUrl) throw new Error("Не удалось открыть свидетельства");
    return { url: link.data.signedUrl };
  });

/** One batch per call; the client repeats until remaining = 0. Idempotent, never updates existing materials/tasks. */
export const publishExtractorJob = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({
    id: z.string().uuid(), subject_id: z.string().uuid(), topic_id: z.string().uuid().nullable().optional(),
    rights_basis: z.enum(["unknown", "own", "licensed", "public_domain"]), confirmed: z.literal(true),
  }).parse(v))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    await assertAdmin(sb, context.userId);
    if (!canPublishWithRights(data.rights_basis)) throw new Error("Права на использование не подтверждены — публикация заблокирована");
    // Explicit admin choice only; applies to this batch call. Must belong to the chosen subject.
    const topicId = data.topic_id ?? null;
    if (topicId) {
      const t = await sb.from("topics").select("id,subject_id").eq("id", topicId).maybeSingle();
      if (t.error) throw new Error(t.error.message);
      if (!t.data || t.data.subject_id !== data.subject_id) throw new Error("Выбранная тема не найдена или не относится к предмету — публикация остановлена");
    }
    const job = await loadJob(sb, data.id);
    if (needsSourceLinkageReview(job)) throw new Error("Неполная привязка к исходнику: публикация заблокирована до проверки полноты и сопоставления");
    if (!canPublishRevision(job.revision)) throw new Error("Повторная обработка (версия " + job.revision + ") не публикуется: нужен отдельный аудит и явное решение о замене");
    if (!["succeeded", "publishing", "published"].includes(job.status)) throw new Error("Результат обработки ещё не получен полностью");
    if (job.worker_rule_version === "pathy-batch-v1" && !topicId) throw new Error("Для публикации нужна утверждённая тема");
    if (job.worker_rule_version === "pathy-batch-v1" && topicId) {
      const approved = await sb.from("curriculum_topic_meta").select("review_status").eq("topic_id", topicId).maybeSingle();
      if (approved.error || approved.data?.review_status !== "approved") throw new Error("Тема не утверждена — публикация остановлена");
    }
    await update(sb, job.id, { status: "publishing", rights_basis: data.rights_basis, subject_id: data.subject_id });
    const decisions = (job.unit_decisions ?? {}) as Record<string, "accept" | "reject">;
    const batch = await sb.from("extractor_job_units").select("id,unit_id,raw,reviewed_text,review_choice,reviewed_by,reviewed_at").eq("job_id", job.id).eq("publish_state", "pending").order("position").limit(PUBLISH_BATCH);
    if (batch.error) throw new Error(batch.error.message);
    const r = { materials: 0, existing: 0, skipped: 0, failed: 0 };
    for (const row of batch.data ?? []) {
      const raw = row.raw as Record<string, any>;
      if (raw?.source?.sha256 !== job.file_sha256) throw new Error("SHA блока не совпадает с источником обработки");
      const reviewedAudit = raw?.source?.intake_mode === "manual_audit" && !!row.reviewed_by && !!row.reviewed_at && ["keep_original", "accept_corrected"].includes(row.review_choice ?? "");
      const reviewedLineBound = lineBoundReviewCandidate(job, raw) && !!row.reviewed_by && !!row.reviewed_at && ["keep_original", "accept_corrected"].includes(row.review_choice ?? "");
      const u = classifyUnit(reviewedAudit || reviewedLineBound ? { ...raw, usable_for_learning: true } : raw, job.author);
      const mark = (publish_state: "published" | "existing" | "skipped" | "failed", extra: { material_id?: string; publish_error?: string } = {}) =>
        supabaseAdmin.from("extractor_job_units").update({ publish_state, ...extra }).eq("id", row.id);
      if (job.worker_rule_version === "pathy-batch-v1" && (!row.reviewed_by || !row.reviewed_at || !["keep_original", "accept_corrected"].includes(row.review_choice ?? ""))) {
        await mark("skipped"); r.skipped++; continue;
      }
      const eff = effectivePublication(u, row.review_choice as any, row.reviewed_text, decisions[u.unit_id]);
      if (!eff.publish) { await mark("skipped"); r.skipped++; continue; }
      const key = stableUnitKey(job.file_sha256, u.unit_id);
      const prior = await sb.from("materials").select("id,extractor_metadata,subject_id").eq("extractor_metadata->>unit_key", key).maybeSingle();
      if (prior.error) throw new Error(prior.error.message);
      if (prior.data) {
        const metadata = prior.data.extractor_metadata as Record<string, any> | null;
        if (prior.data.subject_id !== data.subject_id || canonicalJson(metadata?.original_unit) !== canonicalJson(raw)) {
          throw new Error("Конфликт ранее импортированной единицы; сохранённый материал не изменён");
        }
        await mark("existing", { material_id: prior.data.id }); r.existing++; continue;
      }
      // The legacy book importer stored source SHA + unit_id but no unit_key.
      // Never create a second material for it, or silently adopt conflicting data.
      const legacyId = typeof raw?.source?.legacy_unit_id === "string" ? raw.source.legacy_unit_id : u.unit_id;
      const legacyOriginal = raw?.source?.intake_mode === "manual_audit" ? raw.source.original_audit_unit : raw;
      const legacy = await sb.from("materials").select("id,extractor_metadata,subject_id")
        .eq("extractor_metadata->>unit_id", legacyId).limit(100);
      if (legacy.error) throw new Error(legacy.error.message);
      if ((legacy.data ?? []).length >= 100) throw new Error("Слишком много совпадений unit_id; нужна ручная проверка");
      const sameSource = (legacy.data ?? []).filter((m) => {
        const metadata = m.extractor_metadata as Record<string, any> | null;
        return metadata?.source_sha256 === job.file_sha256;
      });
      if (sameSource.length > 1) throw new Error("Найдены неоднозначные существующие материалы источника");
      if (sameSource.length === 1) {
        const existing = sameSource[0];
        const metadata = existing.extractor_metadata as Record<string, any> | null;
        if (existing.subject_id !== data.subject_id || canonicalJson(metadata?.original_unit) !== canonicalJson(legacyOriginal)) {
          throw new Error("Конфликт ранее импортированной единицы; сохранённый материал не изменён");
        }
        await mark("existing", { material_id: existing.id }); r.existing++; continue;
      }
      const provenance = {
        unit_key: key, job_id: job.id, unit_id: u.unit_id, source_sha256: job.file_sha256, source_file: job.file_name, pages: u.pages,
        role: u.role, related_unit_ids: u.related_unit_ids, classification: u.decision, review_reasons: u.reasons,
        admin_decision: decisions[u.unit_id] ?? null, usable_for_grading: false, quality_status: sourceUnitQuality(eff.text, u.title, u.kind),
        topic_assignment: topicId ? { topic_id: topicId, by: context.userId, mode: "explicit_admin_batch" } : null, review_status: eff.review_status,
        original_ocr_text: u.content_text, original_unit: raw as Json,
        human_correction: row.review_choice ? { choice: row.review_choice, text: row.review_choice === "accept_corrected" ? row.reviewed_text : null, by: row.reviewed_by, at: row.reviewed_at } : null,
      };
      // Visible only to signed-in users (materials SELECT is TO authenticated). Learning only, not grading.
      const mat = await sb.from("materials").insert({
        subject_id: data.subject_id, topic_id: topicId, title: (u.title || u.unit_id).slice(0, 500), content_text: eff.text,
        material_type: kindToMaterialType(u.kind, u.material_type), source_name: u.author, status: "published", is_public: true,
        license_type: data.rights_basis, license_note: `Источник: ${job.file_name}; стр. ${u.pages.join(", ") || "—"}${u.author ? "; автор: " + u.author : ""}; ${eff.review_status === "human_corrected" ? "исправлено вручную" : "автоизвлечено"}, не проверено для оценивания`,
        created_by: context.userId, extractor_metadata: provenance,
      }).select("id").single();
      if (mat.error) {
        if (mat.error.code === "23505") {
          const existing = await sb.from("materials").select("id,extractor_metadata,subject_id").eq("extractor_metadata->>unit_key", key).maybeSingle();
          if (!existing.error && existing.data) {
            const metadata = existing.data.extractor_metadata as Record<string, any> | null;
            if (existing.data.subject_id !== data.subject_id || canonicalJson(metadata?.original_unit) !== canonicalJson(raw)) throw new Error("Конфликт одновременно импортированной единицы");
            await mark("existing", { material_id: existing.data.id }); r.existing++; continue;
          }
        }
        await mark("failed", { publish_error: mat.error.message }); r.failed++; continue;
      }
      await mark("published", { material_id: mat.data.id }); r.materials++;
      // No tasks: v0.6 units carry usable_for_grading:false and answer:null (see canCreateTask).
    }
    const { count, error: countError } = await sb.from("extractor_job_units").select("id", { count: "exact", head: true }).eq("job_id", job.id).eq("publish_state", "pending");
    if (countError || count === null) throw new Error("Не удалось подтвердить завершение публикации");
    const remaining = count ?? 0;
    const prev = (job.publish_report ?? { materials: 0, existing: 0, skipped: 0, failed: 0 }) as typeof r;
    const report = { materials: (prev.materials ?? 0) + r.materials, existing: (prev.existing ?? 0) + r.existing, skipped: (prev.skipped ?? 0) + r.skipped, failed: (prev.failed ?? 0) + r.failed };
    await update(sb, job.id, { status: remaining ? "publishing" : "published", publish_report: report as unknown as Json });
    return { ...r, remaining, total: report };
  });

/** Re-queue skipped units (e.g. after accepting more doubtful blocks). Published ones stay published. */
export const reopenSkippedUnits = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const r = await supabaseAdmin.from("extractor_job_units").update({ publish_state: "pending" }).eq("job_id", data.id).in("publish_state", ["skipped", "failed"]);
    if (r.error) throw new Error(r.error.message);
    return { ok: true };
  });

/**
 * Admin-only list of already published extractor material blocks.
 * This is a separate workflow from publication: one textbook can cover many topics.
 */
/**
 * Apply ONLY individually human-approved text from a completed reprocess
 * revision to an EXISTING material from revision 1. Keep the original material
 * identity, its curricular links, and an append-only prior-text audit trail.
 * No batch auto-accept; no new materials, exam keys or teacher content.
 */
export const publishApprovedExtractorCorrections = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({
    id: z.string().uuid(),
    unit_ids: z.array(z.string().min(1).max(500)).min(1).max(20),
    confirmed: z.literal(true),
  }).parse(v))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    await assertAdmin(sb, context.userId);
    if (new Set(data.unit_ids).size !== data.unit_ids.length) throw new Error("Повтор unit_id в запросе");
    const job = await loadJob(sb, data.id);
    if (job.revision <= 1 || !job.parent_job_id || job.status !== "succeeded"
        || job.worker_rule_version !== REVISION_CORRECTION_VERSION) {
      throw new Error("Доступна только законченная обработка с проверенным новым корректором");
    }
    const root = await loadJob(sb, job.parent_job_id);
    if (root.revision !== 1 || root.status !== "published"
        || root.file_sha256 !== job.file_sha256
        || root.storage_path !== job.storage_path
        || !canPublishWithRights(root.rights_basis)) {
      throw new Error("Нет подтверждённого опубликованного оригинала с действующими правами");
    }
    const fetched = await sb.from("extractor_job_units")
      .select("id,unit_id,raw,publish_state,reviewed_text,review_choice,reviewed_by,reviewed_at")
      .eq("job_id", job.id).in("unit_id", data.unit_ids);
    if (fetched.error) throw new Error(fetched.error.message);
    if ((fetched.data ?? []).length !== data.unit_ids.length)
      throw new Error("Некоторые блоки отсутствуют в выбранной версии источника");

    type Plan = {
      unitRowId: string; unitId: string; materialId: string; oldText: string; text: string;
      previousMetadata: Record<string, any>; reviewer: string; reviewedAt: string;
      alreadyApplied: boolean; machinePatchCount: number;
    };
    const plans: Plan[] = [];
    // Full preflight BEFORE writing any rows: reject mixed, private, unreviewed
    // or wrong-source material batches without partial material mutation.
    for (const row of fetched.data ?? []) {
      const raw = row.raw as Record<string, any>;
      if (raw?.source?.sha256 !== job.file_sha256 || raw?.usable_for_grading !== false)
        throw new Error("Не совпадает SHA исходника или запрещены оценочные задания");
      const c = classifyUnit(raw, job.author);
      if (c.decision === "private" || c.decision === "invalid")
        throw new Error("Приватный или невалидный блок не может быть опубликован");
      const text = approvedRevisionText({
        raw, review_choice: row.review_choice,
        reviewed_text: row.reviewed_text, reviewed_by: row.reviewed_by,
        reviewed_at: row.reviewed_at,
      });
      const key = stableUnitKey(job.file_sha256, row.unit_id);
      const lookup = await sb.from("materials")
        .select("id,content_text,subject_id,status,is_public,extractor_metadata")
        .eq("extractor_metadata->>unit_key", key).maybeSingle();
      if (lookup.error) throw new Error(lookup.error.message);
      const mat = lookup.data;
      const meta = mat?.extractor_metadata as Record<string, any> | null;
      if (!mat || mat.status !== "published" || !mat.is_public
          || mat.subject_id !== root.subject_id
          || meta?.job_id !== root.id || meta?.source_sha256 !== job.file_sha256
          || meta?.unit_id !== row.unit_id || typeof mat.content_text !== "string")
        throw new Error("Для блока не найден точный опубликованный материал первой версии");
      plans.push({
        unitRowId: row.id, unitId: row.unit_id, materialId: mat.id,
        oldText: mat.content_text, text, previousMetadata: meta!,
        reviewer: row.reviewed_by!, reviewedAt: row.reviewed_at!,
        alreadyApplied: correctionAlreadyApplied(meta!, job.id, row.unit_id),
        machinePatchCount: Array.isArray(raw.machine_correction?.patches) ? raw.machine_correction.patches.length : 0,
      });
    }
    let applied = 0, existing = 0;
    for (const p of plans) {
      if (p.alreadyApplied) {
        // Idempotent retry after a successful previous material update.
        existing++;
      } else {
        const at = new Date().toISOString();
        const auditEntry = {
          job_id: job.id, source_revision: job.revision, worker_rule_version: job.worker_rule_version,
          unit_id: p.unitId, previous_text: p.oldText, previous_text_sha256: sha256Text(p.oldText),
          approved_text_sha256: sha256Text(p.text), human_reviewer: p.reviewer,
          reviewed_at: p.reviewedAt, applied_by: context.userId, applied_at: at,
          machine_patch_count: p.machinePatchCount, grading_authorized: false,
        };
        const nextMeta = appendCorrectionHistory(p.previousMetadata, auditEntry);
        const updated = await sb.from("materials")
          .update({ content_text: p.text, extractor_metadata: nextMeta as Json, updated_at: at })
          .eq("id", p.materialId).eq("content_text", p.oldText)
          .eq("status", "published").eq("is_public", true)
          .select("id").maybeSingle();
        if (updated.error) throw new Error(updated.error.message);
        if (!updated.data) throw new Error("Материал изменился параллельно — публикация остановлена");
        applied++;
      }
      const mark = await supabaseAdmin.from("extractor_job_units")
        .update({ publish_state: "published", material_id: p.materialId })
        .eq("id", p.unitRowId).eq("job_id", job.id);
      if (mark.error) throw new Error(mark.error.message);
    }
    // Intentionally do NOT set a revision>1 extractor_jobs.status to published:
    // DB enforces that only the source job itself may be marked published.
    return { applied, existing, total: plans.length };
  });

export const getPublishedExtractorMaterials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ job_id: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    await assertAdmin(sb, context.userId);
    const job = await loadJob(sb, data.job_id);
    const res = await sb.from("materials")
      .select("id,title,material_type,topic_id,subject_id,content_text")
      .eq("extractor_metadata->>job_id", job.id)
      .eq("status", "published").eq("is_public", true)
      .order("created_at", { ascending: true }).limit(500);
    if (res.error) throw new Error(res.error.message);
    const ids = (res.data ?? []).map((m) => m.id);
    const links = ids.length ? await (sb as any).from("material_topic_links")
      .select("material_id,topic_id").in("material_id", ids) : { data: [], error: null };
    if (links.error) throw new Error(links.error.message);
    const linkMap = new Map<string, string[]>();
    for (const link of links.data ?? []) {
      const prior = linkMap.get(link.material_id) ?? [];
      prior.push(link.topic_id);
      linkMap.set(link.material_id, prior);
    }
    return {
      job_id: job.id,
      subject_id: job.subject_id,
      materials: (res.data ?? []).map((m) => ({
        topic_ids: Array.from(new Set([...(m.topic_id ? [m.topic_id] : []), ...(linkMap.get(m.id) ?? [])])),
        id: m.id, title: m.title, material_type: m.material_type,
        topic_id: m.topic_id, characters: (m.content_text ?? "").trim().length,
        preview: (m.content_text ?? "").trim().slice(0, 150),
        needs_content_review: needsContentReview(m.title, m.content_text),
      })),
    };
  });

/**
 * Bulk map explicit, selected published units to one existing topic.
 * Never guess a topic from book/filename and never modify the OCR, grade keys,
 * existing lessons, or user paths. A remap of a material used in a lesson is denied.
 */
export const setPublishedExtractorMaterialsTopic = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({
    job_id: z.string().uuid(),
    material_ids: z.array(z.string().uuid()).min(1).max(25)
      .refine((ids) => new Set(ids).size === ids.length, "Повторяющиеся ID материалов"),
    topic_id: z.string().uuid().nullable(),
  }).parse(v))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    await assertAdmin(sb, context.userId);
    const job = await loadJob(sb, data.job_id);
    if (job.status !== "published" || !job.subject_id) {
      throw new Error("Назначение тем доступно только после публикации с выбранным предметом");
    }
    if (data.topic_id) {
      const t = await sb.from("topics").select("id,subject_id").eq("id", data.topic_id).maybeSingle();
      if (t.error) throw new Error(t.error.message);
      if (!t.data || !topicBelongsToSubject(job.subject_id, t.data.subject_id)) {
        throw new Error("Тема не найдена или принадлежит другому предмету");
      }
    }
    const selected = await sb.from("materials")
      .select("id,subject_id,topic_id,extractor_metadata,status,is_public")
      .in("id", data.material_ids)
      .eq("extractor_metadata->>job_id", job.id);
    if (selected.error) throw new Error(selected.error.message);
    if ((selected.data ?? []).length !== data.material_ids.length) {
      throw new Error("Не все выбранные материалы принадлежат этой обработке");
    }
    const rows = selected.data ?? [];
    for (const m of rows) {
      const meta = m.extractor_metadata as Record<string, any> | null;
      if (m.subject_id !== job.subject_id || m.status !== "published" || !m.is_public ||
          meta?.source_sha256 !== job.file_sha256) {
        throw new Error("Материал не прошёл проверку происхождения, предмета или статуса");
      }
    }
    const changed = rows.filter((m) => m.topic_id !== data.topic_id);
    if (!changed.length) return { updated: 0, unchanged: rows.length };
    // Avoid leaving stale links when an existing lesson already uses the material.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const linked = await supabaseAdmin.from("lesson_materials")
      .select("material_id").in("material_id", changed.map((m) => m.id)).limit(1);
    if (linked.error) throw new Error(linked.error.message);
    if ((linked.data ?? []).length) {
      throw new Error("Один из материалов уже включён в урок. Сначала нужно проверить его существующую привязку.");
    }
    const at = new Date().toISOString();
    for (const m of changed) {
      const meta = m.extractor_metadata as Record<string, any>;
      const record = { topic_id: data.topic_id, by: context.userId, at, mode: "explicit_admin_material" };
      const history = Array.isArray(meta.topic_assignment_history) ? meta.topic_assignment_history : [];
      const next = {
        ...meta, topic_assignment: data.topic_id ? record : null,
        topic_assignment_history: [...history, record],
      };
      const updated = await sb.from("materials")
        .update({ topic_id: data.topic_id, extractor_metadata: next as Json })
        .eq("id", m.id).eq("subject_id", job.subject_id)
        .select("id").single();
      if (updated.error) throw new Error(updated.error.message);
    }
    return { updated: changed.length, unchanged: rows.length - changed.length };
  });

/** Add a second (or third) topic without replacing the legacy primary association. */
export const addPublishedExtractorMaterialTopicLinks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({
    job_id: z.string().uuid(),
    material_ids: z.array(z.string().uuid()).min(1).max(25)
      .refine((ids) => new Set(ids).size === ids.length, "Повторяющиеся ID"),
    topic_id: z.string().uuid(),
  }).parse(v))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    await assertAdmin(sb, context.userId);
    const job = await loadJob(sb, data.job_id);
    if (job.status !== "published" || !job.subject_id) throw new Error("Сначала завершите публикацию исходника");
    const t = await sb.from("topics").select("id,subject_id").eq("id", data.topic_id).maybeSingle();
    if (t.error || !t.data || !topicBelongsToSubject(job.subject_id, t.data.subject_id)) {
      throw new Error("Выбранная тема отсутствует или относится к другому предмету");
    }
    const source = await sb.from("materials")
      .select("id,subject_id,topic_id,extractor_metadata,status,is_public")
      .in("id", data.material_ids).eq("extractor_metadata->>job_id", job.id);
    if (source.error) throw new Error(source.error.message);
    if ((source.data ?? []).length !== data.material_ids.length) throw new Error("Есть материалы из другой обработки");
    for (const m of source.data ?? []) {
      const meta = m.extractor_metadata as Record<string, any> | null;
      if (m.subject_id !== job.subject_id || m.status !== "published" || !m.is_public || meta?.source_sha256 !== job.file_sha256) {
        throw new Error("Невозможно привязать материал с неподтверждённым происхождением");
      }
    }
    const links = data.material_ids.map((id) => ({
      material_id: id, topic_id: data.topic_id, link_type: "explains",
      link_source: "explicit_admin", linked_by: context.userId,
    }));
    const ins = await (sb as any).from("material_topic_links").upsert(links, {
      onConflict: "material_id,topic_id", ignoreDuplicates: true,
    });
    if (ins.error) throw new Error(ins.error.message);
    // Preserve the first association for older screens, but never replace a different topic.
    let firstAssignments = 0;
    for (const m of source.data ?? []) {
      if (m.topic_id) continue;
      const meta = m.extractor_metadata as Record<string, any>;
      const at = new Date().toISOString();
      const update = await sb.from("materials").update({
        topic_id: data.topic_id,
        extractor_metadata: { ...meta, topic_assignment: {
          topic_id: data.topic_id, by: context.userId, at, mode: "explicit_admin_first_topic",
        } } as Json,
      }).eq("id", m.id).is("topic_id", null).select("id");
      if (update.error) throw new Error(update.error.message);
      firstAssignments += update.data?.length ?? 0;
    }
    return { linked: data.material_ids.length, primary_topics_added: firstAssignments };
  });
