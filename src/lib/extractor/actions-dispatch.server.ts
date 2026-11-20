import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** Disabled unless operator explicitly configures the one-run cost and code gates. */
export async function dispatchBatch(jobId: string, userId: string): Promise<void> {
  const token = process.env.PATHY_ACTIONS_DISPATCH_TOKEN;
  const sha = process.env.PATHY_ACTIONS_CODE_SHA;
  const repositoryId = process.env.PATHY_ACTIONS_REPOSITORY_ID;
  const approval = process.env.PATHY_ACTIONS_APPROVAL_ID;
  if (process.env.PATHY_ACTIONS_COST_APPROVED !== "true" || process.env.PATHY_ACTIONS_APPROVED_JOB_ID !== jobId || !approval || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(approval) || !token || !sha || !/^[0-9a-f]{40}$/.test(sha) || !repositoryId || !/^\d+$/.test(repositoryId)) throw new Error("Пакетная обработка ожидает настройки доступа и подтверждения лимита расходов для этого задания");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const ref = await fetch("https://api.github.com/repos/victortsatryan/pathy-content-pipeline/git/ref/heads/main", { headers, redirect: "error", signal: AbortSignal.timeout(10000) });
  if (!ref.ok) throw new Error("Не удалось проверить версию пакетного обработчика");
  const object = await ref.json() as { object?: { sha?: string } };
  if (object.object?.sha !== sha) throw new Error("Версия пакетного обработчика отличается от утверждённой");
  const reserved = await (supabaseAdmin as any).rpc("ext02_reserve_job", { p_job: jobId, p_user: userId, p_sha: sha, p_approval: approval });
  if (reserved.error) throw new Error("Не удалось зарезервировать обработку");
  // Dispatch has no idempotency key. If the response is lost, keep the lease
  // and never automatically retry: a run may already have started.
  const response = await fetch("https://api.github.com/repos/victortsatryan/pathy-content-pipeline/actions/workflows/pathy-batch-intake.yml/dispatches", {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ ref: "main", inputs: { job_id: jobId } }),
  });
  if (!response.ok) throw new Error("Запуск не подтверждён; дождитесь истечения резерва и проверьте Actions");
}
