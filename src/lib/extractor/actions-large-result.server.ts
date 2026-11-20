import { createHash } from "node:crypto";

const MAX_BYTES = 160 * 1024 * 1024;
const MAX_BATCH_BYTES = 1_500_000;
export class ResultIntegrityError extends Error {}

/** Verify the complete private object before any units become visible. */
export async function importStoredResult(client: any, job: string, run: string, sha: string, size: number) {
  if (!/^[0-9a-f]{64}$/.test(sha) || !Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES) throw new ResultIntegrityError("Invalid object identity");
  const path = `ext02-results/${job}/${run}/${sha}.json`;
  const bucket = client.storage.from("extractor-sources");
  const info = await bucket.info(path);
  if (info.error || !info.data) throw new Error("Object unavailable");
  if (Number(info.data.size) !== size) throw new ResultIntegrityError("Object size mismatch");
  const download = await bucket.download(path);
  if (download.error || !download.data) throw new Error("Object unavailable");
  const bytes = Buffer.from(await download.data.arrayBuffer());
  if (bytes.length !== size || createHash("sha256").update(bytes).digest("hex") !== sha) throw new ResultIntegrityError("Object digest mismatch");
  let result: any;
  try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new ResultIntegrityError("Invalid JSON"); }
  const source = result?.source?.sha256, context = result?.pipeline_context, units = result?.units;
  if (result?.format !== "pathy-extraction-result-v1" || !/^[0-9a-f]{64}$/.test(source ?? "") || context?.source_sha256 !== source || context?.source_original_bytes_verified !== true || typeof context?.source_block_linkage_complete !== "boolean" || context?.mode === "manual_audit" || !Array.isArray(units) || units.length < 1 || units.length > 5000 || result?.summary?.total_units !== units.length) throw new ResultIntegrityError("Invalid result metadata");
  const ids = new Set<string>();
  for (const u of units) {
    if (!u || typeof u.unit_id !== "string" || !u.unit_id.startsWith(`source:${source}:unit:`) || ids.has(u.unit_id) || u.source?.sha256 !== source || !["student_material", "teacher_private"].includes(u.role) || u.usable_for_grading !== false || (u.role === "teacher_private" && u.usable_for_learning !== false) || (u.requires_manual_review === true && u.usable_for_learning === true)) throw new ResultIntegrityError("Invalid unit");
    ids.add(u.unit_id);
  }
  for (const u of units) if (!Array.isArray(u.related_unit_ids) || u.related_unit_ids.some((id: unknown) => typeof id !== "string" || !ids.has(id))) throw new ResultIntegrityError("Invalid related unit");
  const lengths = units.map((u: unknown) => Buffer.byteLength(JSON.stringify(u)) + 1);
  if (lengths.some((n: number) => n > MAX_BATCH_BYTES)) throw new ResultIntegrityError("Unit exceeds batch limit");
  const meta = { format: result.format, source: result.source, summary: result.summary, pipeline_context: context, storage: { path, sha256: sha, size } };
  async function rpc(name: string, args: object) {
    const reply = await client.rpc(name, args);
    if (reply.error?.code === "22000" || reply.error?.code === "23505") throw new ResultIntegrityError("Invalid result batch");
    if (reply.error) throw new Error("Result transaction failed");
  }
  await rpc("ext02_begin_large_result", { p_job: job, p_run: run, p_meta: meta });
  let offset = 0;
  while (offset < units.length) {
    const batch: unknown[] = []; let count = 2;
    while (offset + batch.length < units.length && batch.length < 100) {
      const unit = units[offset + batch.length];
      const length = lengths[offset + batch.length];
      if (count + length > MAX_BATCH_BYTES) break;
      count += length; batch.push(unit);
    }
    await rpc("ext02_append_large_result", { p_job: job, p_run: run, p_offset: offset, p_units: batch });
    offset += batch.length;
  }
  await rpc("ext02_finish_large_result", { p_job: job, p_run: run, p_digest: sha });
}
