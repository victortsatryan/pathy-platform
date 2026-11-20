import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const service = vi.hoisted(() => ({ db: null as any }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: new Proxy({}, { get: (_t, key) => service.db[key] }) }));

// No production client is loaded. RPC wrappers, database and worker HTTP are isolated in memory.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const chain = { middleware: () => chain, inputValidator: () => chain, handler: (fn: unknown) => fn };
    return chain;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

import { publishExtractorJob, refreshExtractorJob, saveExtractorUnitReview, getExtractorJobs } from "../src/lib/extractor/jobs.functions";
const sha = "a".repeat(64);
const jobId = "11111111-1111-4111-8111-111111111111";
const subjectId = "22222222-2222-4222-8222-222222222222";
const topicOwn = "44444444-4444-4444-8444-444444444444";
const topicForeign = "55555555-5555-4555-8555-555555555555";
const topicMissing = "66666666-6666-4666-8666-666666666666";
type Row = Record<string, any>;
const rawUnit = (i: number, overrides: Row = {}) => ({
  unit_id: `u${i}`, role: "student_material", kind: "exercise", title: `Unit ${i}`,
  content_text: `Source text ${i}`, pages: [i + 1], source: { sha256: sha, author: "Source author" },
  usable_for_learning: true, usable_for_grading: false, answer: null, ...overrides,
});

function memoryDatabase(admin = true) {
  const tables: Record<string, Row[]> = {
    extractor_jobs: [{ id: jobId, file_sha256: sha, file_name: "isolated.txt", status: "succeeded", author: null, unit_decisions: {}, publish_report: null }],
    extractor_job_units: [], materials: [], subjects: [],
    topics: [{ id: topicOwn, subject_id: subjectId }, { id: topicForeign, subject_id: "33333333-3333-4333-8333-333333333333" }],
  };
  let writes = 0;
  const sb = {
    rpc: vi.fn(async () => ({ data: admin, error: null })),
    from: (name: string) => {
      const filters: ((r: Row) => boolean)[] = [];
      let action = "select", payload: any, limit = Infinity, single = false, count = false;
      const q: any = {
        select: (_fields?: string, opts?: Row) => { count = opts?.count === "exact"; return q; },
        eq: (key: string, value: unknown) => { filters.push(r => (key.startsWith("extractor_metadata->>") ? r.extractor_metadata?.[key.split("->>")[1]] : r[key]) === value); return q; },
        order: () => q, limit: (n: number) => { limit = n; return q; },
        single: () => { single = true; return q; }, maybeSingle: () => { single = true; return q; },
        update: (value: Row) => { action = "update"; payload = value; return q; },
        insert: (value: Row) => { action = "insert"; payload = value; return q; },
        upsert: (value: Row[]) => { action = "upsert"; payload = value; return q; },
        then: (resolve: (r: Row) => unknown) => {
          const rows = tables[name];
          if (!rows) throw new Error(`Unexpected table ${name}`);
          let found = rows.filter(r => filters.every(f => f(r))).slice(0, limit);
          if (action === "update") { writes++; found.forEach(r => Object.assign(r, payload)); }
          if (action === "insert") { writes++; const row = { id: `m${rows.length}`, ...payload }; rows.push(row); found = [row]; }
          if (action === "upsert") {
            writes++;
            for (const row of payload) if (!rows.some(r => r.job_id === row.job_id && r.unit_id === row.unit_id)) rows.push({ id: row.unit_id, publish_state: "pending", ...row });
          }
          return Promise.resolve(resolve({ data: single ? found[0] ?? null : found, error: null, count: count ? found.length : null }));
        },
      };
      return q;
    },
  };
  return { tables, sb, writes: () => writes };
}

// Invoke the actual handler body; middleware transport is intentionally not part of this mock test.
const invoke = (fn: unknown, db: ReturnType<typeof memoryDatabase>, data?: Row) =>
  (service.db = db.sb, (fn as (arg: unknown) => Promise<any>)({ data, context: { supabase: db.sb, userId: "isolated-admin" } }));
const publishInput = { id: jobId, subject_id: subjectId, rights_basis: "licensed", confirmed: true };

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
beforeEach(() => {
  vi.stubEnv("PATHY_EXTRACTOR_API_URL", "");
  vi.stubEnv("PATHY_EXTRACTOR_API_TOKEN", "");
});

describe("isolated actual extractor handlers (mock DB + worker, not LIVE E2E)", () => {
  it.each(["student", "teacher"])("denies %s before reading or writing job data", async () => {
    const db = memoryDatabase(false);
    await expect(invoke(publishExtractorJob, db, publishInput)).rejects.toThrow("администратору");
    expect(db.writes()).toBe(0);
    expect(db.tables.materials).toHaveLength(0);
  });
  it("reports worker not configured without a job or network call", async () => {
    const db = memoryDatabase(); const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect((await invoke(getExtractorJobs, db)).workerConfigured).toBe(false);
    expect(db.writes()).toBe(0); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not report readiness when the one-run approval is missing", async () => {
    const db = memoryDatabase();
    vi.stubEnv("PATHY_ACTIONS_COST_APPROVED", "true");
    vi.stubEnv("PATHY_ACTIONS_APPROVED_JOB_ID", jobId);
    vi.stubEnv("PATHY_ACTIONS_DISPATCH_TOKEN", "fixture");
    vi.stubEnv("PATHY_ACTIONS_CODE_SHA", "a".repeat(40));
    vi.stubEnv("PATHY_ACTIONS_REPOSITORY_ID", "1419587278");
    vi.stubEnv("PATHY_ACTIONS_APPROVAL_ID", "");
    expect((await invoke(getExtractorJobs, db)).workerConfigured).toBe(false);
    vi.stubEnv("PATHY_ACTIONS_APPROVAL_ID", "20000000-0000-4000-8000-000000000001");
    expect((await invoke(getExtractorJobs, db)).workerConfigured).toBe(true);
  });
  it("rights gate denies unknown rights before any write", async () => {
    const db = memoryDatabase();
    await expect(invoke(publishExtractorJob, db, { ...publishInput, rights_basis: "unknown" })).rejects.toThrow("Права");
    expect(db.writes()).toBe(0);
  });
  it("requires a saved human decision and an approved topic for batch results", async () => {
    const db = memoryDatabase();
    db.tables.extractor_jobs[0].worker_rule_version = "pathy-batch-v1";
    db.tables.extractor_jobs[0].result = {pipeline_context:{source_block_linkage_complete:true}};
    db.tables.curriculum_topic_meta = [{topic_id:topicOwn,review_status:'approved'}];
    db.tables.extractor_job_units.push({id:'r',job_id:jobId,unit_id:'u0',publish_state:'pending',raw:rawUnit(0)});
    await expect(invoke(publishExtractorJob,db,publishInput)).rejects.toThrow('утверждённая тема');
    await invoke(publishExtractorJob,db,{...publishInput,topic_id:topicOwn});
    expect(db.tables.materials).toHaveLength(0);
    const next = memoryDatabase();
    next.tables.extractor_jobs[0].worker_rule_version = "pathy-batch-v1";
    next.tables.extractor_jobs[0].result = {pipeline_context:{source_block_linkage_complete:true}};
    next.tables.curriculum_topic_meta = [{topic_id:topicOwn,review_status:'draft'}];
    next.tables.extractor_job_units.push({id:'r',job_id:jobId,unit_id:'u0',publish_state:'pending',raw:rawUnit(0),review_choice:'keep_original',reviewed_by:'admin',reviewed_at:'2026-01-01'});
    await expect(invoke(publishExtractorJob,next,{...publishInput,topic_id:topicOwn})).rejects.toThrow('не утверждена');
    next.tables.curriculum_topic_meta[0].review_status='approved';
    await invoke(publishExtractorJob,next,{...publishInput,topic_id:topicOwn});
    expect(next.tables.materials).toHaveLength(1);
  });
  it("sends manual audit units through the same visible review and publication gate", async () => {
    const db = memoryDatabase();
    db.tables.extractor_jobs[0].worker_rule_version = "pathy-batch-v1";
    db.tables.extractor_jobs[0].result = {pipeline_context:{mode:'manual_audit',source_block_linkage_complete:false}};
    db.tables.curriculum_topic_meta = [{topic_id:topicOwn,review_status:'approved'}];
    const original = {unit_id:'legacy-1',content_text:'source text'};
    const raw = rawUnit(0, { content_text:'source text', requires_manual_review:true, usable_for_learning:false,
      source:{sha256:sha,intake_mode:'manual_audit',legacy_unit_id:'legacy-1',original_audit_unit:original} });
    db.tables.extractor_job_units.push({id:'r',job_id:jobId,unit_id:'u0',publish_state:'pending',raw});
    const before = await invoke(refreshExtractorJob, db, {id:jobId});
    expect(before.units[0]).toMatchObject({decision:'review',publish:false,content_text:'source text'});
    await invoke(saveExtractorUnitReview,db,{id:jobId,unit_id:'u0',choice:'keep_original',reviewed_text:null});
    const after = await invoke(refreshExtractorJob, db, {id:jobId});
    expect(after.units[0]).toMatchObject({decision:'review',publish:true});
    await invoke(publishExtractorJob,db,{...publishInput,topic_id:topicOwn});
    expect(db.tables.materials).toHaveLength(1);
    expect(db.tables.materials[0].extractor_metadata.original_unit.source.original_audit_unit).toEqual(original);
  });
  it("preserves incomplete-linkage evidence in review and blocks publication even after a decision", async () => {
    const db = memoryDatabase();
    const job = db.tables.extractor_jobs[0];
    job.worker_rule_version = 'pathy-batch-v1'; job.stage = 'review_required';
    job.result = {pipeline_context:{source_block_linkage_complete:false, source_sha256:sha, review_actionable_items:1}};
    const raw: Row = rawUnit(0, {usable_for_learning:false, requires_manual_review:true,
      review_reasons:['uncertain_geometry'], source:{sha256:sha,source_lines:[{page:3,bbox_pdf_pts:[1,2,3,4],text:'original'}]},
      pipeline_stage:{status:'scanned_ege_preview_not_source_block_verified'}});
    db.tables.extractor_job_units.push({id:'r',job_id:jobId,unit_id:'u0',publish_state:'pending',raw});
    const before = await invoke(refreshExtractorJob,db,{id:jobId});
    expect(before.linkageReview).toBe(true);
    expect(before.units[0]).toMatchObject({decision:'review',publish:false,content_text:raw.content_text,source_evidence:{source:raw.source,pipeline_stage:raw.pipeline_stage}});
    expect(before.units[0].reasons).toContain('uncertain_geometry');
    await invoke(saveExtractorUnitReview,db,{id:jobId,unit_id:'u0',choice:'keep_original',reviewed_text:null});
    expect((await invoke(refreshExtractorJob,db,{id:jobId})).units[0].publish).toBe(false);
    await expect(invoke(publishExtractorJob,db,publishInput)).rejects.toThrow('Неполная привязка');
    expect(db.tables.extractor_job_units[0].raw).toEqual(raw);
    expect(db.tables.materials).toHaveLength(0);
  });
  it("preserves a matching legacy import and rejects a conflicting one", async () => {
    const db = memoryDatabase(); const raw = rawUnit(0);
    db.tables.materials.push({id:'old',subject_id:subjectId,extractor_metadata:{unit_id:raw.unit_id,source_sha256:sha,original_unit:raw}});
    db.tables.extractor_job_units.push({id:'r',job_id:jobId,unit_id:raw.unit_id,publish_state:'pending',raw});
    await invoke(publishExtractorJob,db,publishInput);
    expect(db.tables.materials).toHaveLength(1);
    db.tables.extractor_job_units[0].publish_state='pending';
    db.tables.extractor_job_units[0].raw={...raw,content_text:'conflict'};
    await expect(invoke(publishExtractorJob,db,publishInput)).rejects.toThrow('Конфликт');
    expect(db.tables.materials).toHaveLength(1);
    expect(db.tables.materials[0].extractor_metadata.original_unit.content_text).toBe(raw.content_text);
  });
  it("runs review -> batched publication -> repeat with attribution, privacy and no grading", async () => {
    const db = memoryDatabase();
    const raws = [rawUnit(0), rawUnit(1, { requires_manual_review: true }), rawUnit(2, { role: "teacher_private", content_text: "27. answer" }), ...Array.from({ length: 31 }, (_, i) => rawUnit(i + 3))];
    db.tables.extractor_job_units = raws.map((raw, i) => ({ id: `row${i}`, job_id: jobId, unit_id: raw.unit_id, raw, publish_state: "pending" }));
    await invoke(saveExtractorUnitReview, db, { id: jobId, unit_id: "u1", choice: "accept_corrected", reviewed_text: "Human corrected" });
    const first = await invoke(publishExtractorJob, db, publishInput);
    expect(first.remaining).toBe(4);
    expect(first.materials).toBe(29);
    expect((await invoke(publishExtractorJob, db, publishInput)).remaining).toBe(0);
    expect(db.tables.materials).toHaveLength(33);
    expect(db.tables.materials.find(m => m.extractor_metadata.unit_id === "u2")).toBeUndefined();
    const corrected = db.tables.materials.find(m => m.extractor_metadata.unit_id === "u1");
    expect(corrected?.content_text).toBe("Human corrected");
    expect(corrected?.extractor_metadata.original_ocr_text).toBe("Source text 1");
    expect(corrected?.source_name).toBe("Source author");
    expect(corrected?.extractor_metadata.source_sha256).toBe(sha);
    expect(corrected?.extractor_metadata.usable_for_grading).toBe(false);
    expect(corrected?.topic_id).toBeNull();
    // Replay persisted units: actual handler reads existing stable identities and never inserts again.
    db.tables.extractor_job_units.forEach(r => { r.publish_state = "pending"; });
    await invoke(publishExtractorJob, db, publishInput); await invoke(publishExtractorJob, db, publishInput);
    expect(db.tables.materials).toHaveLength(33);
  });
  it("flagged units without acceptance stay unpublished", async () => {
    const db = memoryDatabase();
    db.tables.extractor_job_units.push({ id: "r", job_id: jobId, unit_id: "u0", publish_state: "pending", raw: rawUnit(0, { review_status: "needs_review" }) });
    await invoke(publishExtractorJob, db, publishInput);
    expect(db.tables.materials).toHaveLength(0);
  });
  it("does not contact the retired HTTP worker when reopening a historical job", async () => {
    const db = memoryDatabase();
    Object.assign(db.tables.extractor_jobs[0], { status: "fetching_result", external_job_id: jobId });
    vi.stubEnv("PATHY_EXTRACTOR_API_URL", "https://worker.invalid");
    vi.stubEnv("PATHY_EXTRACTOR_API_TOKEN", "isolated-fixture");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await invoke(refreshExtractorJob, db, { id: jobId });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.tables.extractor_job_units).toHaveLength(0);
  });
});
describe("explicit admin topic assignment (isolated mock DB)", () => {
  const seed = (db: ReturnType<typeof memoryDatabase>) => {
    const raws = [rawUnit(0), rawUnit(1, { role: "teacher_private", content_text: "27. answer" }), rawUnit(2, { answer: "42", usable_for_grading: true })];
    db.tables.extractor_job_units = raws.map((raw, i) => ({ id: `row${i}`, job_id: jobId, unit_id: raw.unit_id, raw, publish_state: "pending" }));
    db.tables.tasks = [];
  };
  it("assigns the chosen topic of the same subject to published materials only", async () => {
    const db = memoryDatabase(); seed(db);
    await invoke(publishExtractorJob, db, { ...publishInput, topic_id: topicOwn });
    expect(db.tables.materials).toHaveLength(2);
    expect(db.tables.materials.every(m => m.topic_id === topicOwn && m.subject_id === subjectId)).toBe(true);
    expect(db.tables.materials[0].extractor_metadata.topic_assignment).toMatchObject({ topic_id: topicOwn, mode: "explicit_admin_batch" });
    expect(db.tables.materials.find(m => m.extractor_metadata.unit_id === "u1")).toBeUndefined();
    expect(db.tables.materials.every(m => m.extractor_metadata.usable_for_grading === false)).toBe(true);
    expect(db.tables.tasks).toHaveLength(0);
  });
  it.each([["foreign subject", topicForeign], ["nonexistent", topicMissing]])("rejects %s topic before any write", async (_n, t) => {
    const db = memoryDatabase(); seed(db);
    await expect(invoke(publishExtractorJob, db, { ...publishInput, topic_id: t })).rejects.toThrow("тема");
    expect(db.writes()).toBe(0); expect(db.tables.materials).toHaveLength(0);
  });
  it.each([null, undefined])("empty topic (%s) keeps topic_id null", async (t) => {
    const db = memoryDatabase(); seed(db);
    await invoke(publishExtractorJob, db, { ...publishInput, topic_id: t });
    expect(db.tables.materials.length).toBeGreaterThan(0);
    expect(db.tables.materials.every(m => m.topic_id === null && m.extractor_metadata.topic_assignment === null)).toBe(true);
  });
  it("rights gate still blocks even with a valid topic", async () => {
    const db = memoryDatabase(); seed(db);
    await expect(invoke(publishExtractorJob, db, { ...publishInput, topic_id: topicOwn, rights_basis: "unknown" })).rejects.toThrow("Права");
    expect(db.writes()).toBe(0);
  });
});
