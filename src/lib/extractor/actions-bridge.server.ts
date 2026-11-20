import { createHash } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { authenticateBatchOidc } from "./actions-oidc.server";
import { importStoredResult, ResultIntegrityError } from "./actions-large-result.server";

const uuid = z.string().uuid();
const MAX_RESULT = 16_000_000;
async function boundedBody(request: Request): Promise<Buffer> {
  if (!request.body) throw new Error("Missing body");
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > MAX_RESULT) throw new Error("Too large"); chunks.push(part.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks);
}
export async function batchBridge(request: Request): Promise<Response> {
  try {
    const sha = process.env.PATHY_ACTIONS_CODE_SHA ?? "";
    const repositoryId = process.env.PATHY_ACTIONS_REPOSITORY_ID ?? "";
    const auth = request.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) throw new Error("Unauthorized");
    const run = await authenticateBatchOidc(auth.slice(7), { sha, repositoryId });
    const raw = await boundedBody(request);
    const body = JSON.parse(raw.toString("utf8"));
    const job = uuid.parse(body.job_id);
    const client = supabaseAdmin as any;
    if (body.action === "claim") {
      const result = await client.rpc("ext02_claim_job", { p_job: job, p_run: run.runId, p_sha: run.sha });
      if (result.error || !result.data) throw new Error("Claim failed");
      const source = result.data;
      if (typeof source.storage_path !== "string" || !source.storage_path.startsWith(`${source.sha256}/`)) throw new Error("Invalid source");
      const link = await client.storage.from("extractor-sources").createSignedUrl(source.storage_path, 300);
      if (link.error || !link.data?.signedUrl) throw new Error("Source unavailable");
      return Response.json({ sha256: source.sha256, filename: source.filename, size: source.size, revision: source.revision, source_url: link.data.signedUrl }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "prepare_result" || body.action === "complete_stored") {
      const identity = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().positive().max(160 * 1024 * 1024) }).parse(body.object);
      const allowed = body.action === "prepare_result"
        ? await client.rpc("ext02_claim_job", { p_job: job, p_run: run.runId, p_sha: run.sha })
        : await client.rpc("ext02_assert_large_job", { p_job: job, p_run: run.runId, p_sha: run.sha });
      if (allowed.error) throw new Error("Invalid run or lease");
      const path = `ext02-results/${job}/${run.runId}/${identity.sha256}.json`;
      if (body.action === "prepare_result") {
        const recorded = await client.rpc("ext02_register_result_object", { p_job: job, p_run: run.runId, p_sha: identity.sha256, p_size: identity.size });
        if (recorded.error) throw new Error("Object registration failed");
        const signed = await client.storage.from("extractor-sources").createSignedUploadUrl(path);
        if (signed.error || !signed.data?.signedUrl) throw new Error("Upload unavailable");
        return Response.json({ upload_url: signed.data.signedUrl }, { headers: { "Cache-Control": "no-store" } });
      }
      try { await importStoredResult(client, job, run.runId, identity.sha256, identity.size); }
      catch (error) {
        if (!(error instanceof ResultIntegrityError)) throw error;
        await client.rpc("ext02_fail_job", { p_job: job, p_run: run.runId, p_kind: "integrity" });
        return Response.json({ error: "Result integrity check failed" }, { status: 422, headers: { "Cache-Control": "no-store" } });
      }
      return Response.json({ accepted: true });
    }
    if (body.action === "complete") {
      const expected = request.headers.get("x-pathy-body-sha256") ?? "";
      if (!/^[0-9a-f]{64}$/.test(expected) || createHash("sha256").update(raw).digest("hex") !== expected) {
        await client.rpc("ext02_fail_job", { p_job: job, p_run: run.runId, p_kind: "integrity" });
        return Response.json({ error: "Result integrity check failed" }, { status: 422, headers: { "Cache-Control": "no-store" } });
      }
      const result = await client.rpc("ext02_complete_job", { p_job: job, p_run: run.runId, p_result: body.result });
      if (result.error?.code === "22000") {
        await client.rpc("ext02_fail_job", { p_job: job, p_run: run.runId, p_kind: "integrity" });
        return Response.json({ error: "Result integrity check failed" }, { status: 422, headers: { "Cache-Control": "no-store" } });
      }
      if (result.error) throw new Error("Invalid result or lease");
      return Response.json({ accepted: true });
    }
    if (body.action === "fail") {
      const kind = z.enum(["technical", "integrity"]).parse(body.failure_kind ?? "technical");
      const result = await client.rpc("ext02_fail_job", { p_job: job, p_run: run.runId, p_kind: kind });
      if (result.error) throw new Error("Invalid lease");
      return Response.json({ accepted: true });
    }
    throw new Error("Unknown action");
  } catch {
    // Do not log tokens, signed source URLs, private material or provider errors.
    return Response.json({ error: "Batch request rejected" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
}
