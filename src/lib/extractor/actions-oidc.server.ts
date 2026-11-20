import { createPublicKey, verify } from "node:crypto";

const ISSUER = "https://token.actions.githubusercontent.com";
const AUDIENCE = "pathy-ext02-batch-v1";
type Jwk = { kid: string; kty: string; alg?: string; use?: string };

/** Authenticate the actual GitHub Actions run. No Supabase credential is sent to Actions. */
export async function authenticateBatchOidc(token: string, config: { repositoryId: string; sha: string }): Promise<{ runId: string; sha: string }> {
  if (token.length > 16000 || !/^\d+$/.test(config.repositoryId) || !/^[0-9a-f]{40}$/.test(config.sha)) throw new Error("Invalid configuration");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error("Invalid token");
  let header: any, claims: any;
  try { header = JSON.parse(Buffer.from(parts[0], "base64url").toString()); claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()); }
  catch { throw new Error("Invalid token"); }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Invalid token");
  const response = await fetch(`${ISSUER}/.well-known/jwks`, { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!response.ok) throw new Error("OIDC keys unavailable");
  const payload = await response.json() as { keys?: Jwk[] };
  const key = payload.keys?.find(k => k.kid === header.kid && k.kty === "RSA" && (!k.alg || k.alg === "RS256") && (!k.use || k.use === "sig"));
  if (!key || !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: key as any, format: "jwk" }), Buffer.from(parts[2], "base64url"))) throw new Error("Invalid token");
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== ISSUER || claims.aud !== AUDIENCE || claims.repository !== "victortsatryan/pathy-content-pipeline" || claims.repository_id !== config.repositoryId || claims.sha !== config.sha || claims.ref !== "refs/heads/main" || claims.event_name !== "workflow_dispatch" || claims.workflow_ref !== "victortsatryan/pathy-content-pipeline/.github/workflows/pathy-batch-intake.yml@refs/heads/main" || claims.run_attempt !== "1" || !/^\d{1,30}$/.test(claims.run_id ?? "") || !Number.isInteger(claims.exp) || !Number.isInteger(claims.iat) || claims.exp <= now || claims.iat > now + 30 || claims.iat < now - 900 || (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > now + 30))) throw new Error("Unauthorized workflow");
  return { runId: claims.run_id, sha: config.sha };
}
