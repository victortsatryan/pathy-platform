import { createHash } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { EXTRACTOR_FORMAT, inspectFile, sourceSha, unitSchema } from "./schema";
import { MAX_SOURCE_BYTES, sourceExtension } from "./pipeline";
import { verifySourceResponse } from "./source-verification.server";

export const auditIntakeSchema = z.object({
  job_id: z.string().uuid(), confirmed: z.literal(true), units: z.array(z.unknown()).min(1).max(5000),
  envelope_metadata: z.record(z.string(), z.unknown()).optional(),
}).refine(v => new TextEncoder().encode(JSON.stringify(v)).length <= 15_000_000, "Результат превышает 15 MB");

/** All manual audit inputs use the same source-bound job, units and review as Actions. */
export async function importAuditResult(sb: any, userId: string, input: z.infer<typeof auditIntakeSchema>) {
  const role = await sb.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (role.error || !role.data) throw new Error("Доступ только администратору");
  if (input.envelope_metadata && ("units" in input.envelope_metadata || (input.envelope_metadata.format !== undefined && input.envelope_metadata.format !== EXTRACTOR_FORMAT))) throw new Error("Некорректные метаданные результата");
  const checked = inspectFile({ format: EXTRACTOR_FORMAT, units: input.units });
  if (checked.errors.length || checked.reports.some(r => r.status === "failed")) throw new Error("Результат содержит неверные или повторные единицы; ничего не сохранено");
  const job = await sb.from("extractor_jobs").select("id,file_sha256,file_name,size_bytes,storage_path").eq("id", input.job_id).single();
  if (job.error || !job.data) throw new Error("Задание источника не найдено");
  const source = job.data;
  const ext = sourceExtension(source.file_name);
  const size = Number(source.size_bytes);
  if (!ext || !source.storage_path.startsWith(`${source.file_sha256}/`) || !Number.isSafeInteger(size) || size < 1 || size > MAX_SOURCE_BYTES) throw new Error("Исходный файл задания недоступен или некорректен");
  const units = input.units.map((raw: any) => {
    const u = unitSchema.parse(raw);
    if (sourceSha(u) !== source.file_sha256) throw new Error("SHA единицы не совпадает с исходником задания");
    if (raw.role != null && raw.role !== "student_material" && raw.role !== "teacher_private") throw new Error("Неизвестная роль единицы");
    const role = raw.role === "teacher_private" || /answer|solution|explanation|ключ|ответ/i.test(u.kind) ? "teacher_private" : "student_material";
    const id = createHash("sha256").update(u.unit_id, "utf8").digest("hex");
    return { unit_id: `source:${source.file_sha256}:unit:legacy:${id}`, source_id: u.unit_id,
      kind: raw.kind, title: raw.title, content_text: raw.content_text, pages: u.pages,
      source: { ...u.source, sha256: source.file_sha256, intake_mode: "manual_audit", legacy_unit_id: u.unit_id, original_audit_unit: raw },
      role, related_unit_ids: [], review_status: "needs_review", review_reasons: ["manual_source_and_text_review_required"],
      requires_manual_review: true, usable_for_learning: false, usable_for_grading: false };
  });
  const link = await sb.storage.from("extractor-sources").createSignedUrl(source.storage_path, 120);
  if (link.error || !link.data?.signedUrl) throw new Error("Исходный файл недоступен");
  const response = await fetch(link.data.signedUrl, { signal: AbortSignal.timeout(20_000) });
  await verifySourceResponse(response, { sha256: source.file_sha256, size, extension: ext });
  const result = { format: "pathy-extraction-result-v1", source: { sha256: source.file_sha256, filename: source.file_name }, audit_envelope_metadata: input.envelope_metadata ?? { format: EXTRACTOR_FORMAT },
    summary: { total_units: units.length }, pipeline_context: { source_sha256: source.file_sha256, source_original_bytes_verified: true, source_block_linkage_complete: false, mode: "manual_audit" }, units };
  const stored = await (supabaseAdmin as any).rpc("ext02_import_audit_result", { p_job: input.job_id, p_user: userId, p_result: result });
  if (stored.error) throw new Error("Не удалось сохранить результат: проверьте состояние задания и наличие конфликта");
  return { job_id: input.job_id, count: units.length };
}
