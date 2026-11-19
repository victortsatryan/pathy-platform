# EXT-02 batch configuration (pre-release)

This is a staging configuration guide, not permission to deploy, run an action,
or alter production. The GitHub OIDC identity is exchanged for a narrowly scoped
server interface. Actions never receive a Supabase service-role key or direct
database credentials. The existing server-side Supabase service-role credential
is used only by the Pathy server for the restricted SQL functions and Storage.

**Implementation remains incomplete:** the legacy book and audit-staging
imports have not yet been routed through the job/review/publication intake.
Cross-path duplicate detection does not make them one intake. Do not deploy or
enable this draft as the completed EXT-02 / LIB-01 solution.

Before enabling, review the migrations and the deployment target, determine the
existing GitHub Actions plan, available included minutes and spending limits,
and obtain approval for the specific run if it could incur cost. Review the
actual deployed application SHA and approved Python `main` SHA independently;
do not infer either from editor state. Verify the workflow is present in private
repository `victortsatryan/pathy-content-pipeline` on that exact main SHA.

Configure the Pathy server through its supported secret/configuration interface:

- `PATHY_ACTIONS_DISPATCH_TOKEN`: fine-grained GitHub token limited to the private
  pipeline repository, with Actions read/write (workflow dispatch) and Contents
  read (verify the main ref), no other repositories or permissions. Set an
  expiration and rotate/revoke through the issuer. Never put it in client code,
  the GitHub workflow, logs, or a chat.
- `PATHY_ACTIONS_CODE_SHA`: exact 40-character approved pipeline main SHA.
- `PATHY_ACTIONS_REPOSITORY_ID`: numeric private repository ID `1419587278`.
- `PATHY_ACTIONS_COST_APPROVED`: `true` only after the above cost gate.
- `PATHY_ACTIONS_APPROVAL_ID`: a fresh UUID for this one approved run; use a new
  value for an explicitly approved retry (at most two attempts).
- `PATHY_ACTIONS_APPROVED_JOB_ID`: the one approved Pathy job UUID. It must match
  the request. Remove it and set cost approval false after the run.

The existing `SUPABASE_URL` and server-only `SUPABASE_SERVICE_ROLE_KEY` must be
configured by the platform's supported mechanism; do not create or expose a
new broad credential. In the **private pipeline** repository configure Actions
variables `PATHY_BATCH_BRIDGE_URL` as the exact HTTPS app origin followed by
`/api/ext02-batch`, and `PATHY_ACTIONS_COST_APPROVED=true` only for the approved
run. These are configuration values, not database secrets. OIDC permission is
`id-token: write`; there is no Actions Supabase secret. Default is disabled.

An authorized admin first uploads a source; registration verifies stored bytes.
When launch is disabled the job remains waiting. After the exact job is approved
and settings verified, use its retry action. The dispatcher checks the main SHA,
reserves one run, and sends only the opaque job ID. The bridge verifies GitHub
OIDC issuer, audience, repository ID, workflow/ref, event, SHA, run and attempt;
the DB claims a bounded lease. The client downloads from the exact existing
Supabase host, verifies bytes, runs the existing extractor, then sends the
private source-bound result for transactional insertion into existing job units.
No logs or Actions artifacts contain source/results. Timeout, error and conflicts
fail closed; no automatic dispatch retry is made after an uncertain response.

Validate in an already authorized isolated environment: roles, direct REST denial,
private-source access, run/SHA mismatch, one-run concurrency, byte and result
integrity, failure, timeout, repeat, prior revisions/review, topic and rights
checks, and end-to-end review/publication. These conditions and an independently
verified secure Lovable secret/deploy mechanism remain release gates. A rollback
turns both cost approvals off and removes the job approval; retain all existing
jobs, units, results and manual decisions. Never revert to Cloud Run. Do not
apply migrations to production until the controlled release is approved.
