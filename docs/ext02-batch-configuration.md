# EXT-02 batch configuration (pre-release)

This is a staging configuration guide, not permission to deploy, run an action,
or alter production. The GitHub OIDC identity is exchanged for a narrowly scoped
server interface. Actions never receive a Supabase service-role key or direct
database credentials. The existing server-side Supabase service-role credential
is used only by the Pathy server for the restricted SQL functions and Storage.

**Implementation remains incomplete:** the Extractor book and audit entry
points now use job/review/publication intake, but the existing CSV, PCS and
community material flows have not all been moved to that common contract.
Do not deploy or enable this draft as the completed EXT-02 / LIB-01 solution.
In particular, `admin-materials.functions.ts` can create topics and update
existing materials, `pcs.functions.ts` still calls the independent PCS import
RPCs, and community candidates have their own publication state. Those
behaviors and their existing data must be reconciled without silently rewriting
published content, inventing curriculum links, or removing the existing forms.
CSV preview is now read-only and counts valid rows only; it does not predict
whether a row would be inserted or updated. This fix does not move CSV writes
into the common intake.
`20261119122000_community_author_status_guard.sql` independently closes direct
author promotion and forged moderation fields while preserving existing rows
and administrator moderation. It does not unify community publication.

Before enabling, review the migrations and the deployment target, determine the
existing GitHub Actions plan, available included minutes and spending limits,
and obtain approval for the specific run if it could incur cost. Review the
actual deployed application SHA and approved Python `main` SHA independently;
do not infer either from editor state. Verify the workflow is present in private
repository `victortsatryan/pathy-content-pipeline` on that exact main SHA.
Confirm that the target schema includes the required accepted security changes
and that the managed platform supports applying the selected migrations without
replaying unrelated SQL. Use the previously documented maintenance and support
procedure; do not repair migration records or apply changes as part of setup.

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

For an existing audit JSON file, the admin first uploads the corresponding
original file, then selects the matching job by source SHA in the existing
import form. Both former audit entry points use the same job transaction. The
server verifies the original bytes again and preserves each original audit
object; block linkage is explicitly recorded as unverified. Each unit requires
human review before any publication, which additionally requires confirmed
rights and an approved topic. Identical retries preserve saved reviews; changed
payloads are rejected. Historical audit-staging rows remain readable. New
direct staging writes and client mutations of raw jobs/units are revoked.
The two migrations are `20261119120000_ext02_batch_jobs.sql` (batch and
manual transaction) and `20261119121000_ext02_audit_archive_readonly.sql`
(write revocations). The second migration is incompatible with the old
server's direct writes: rehearse and drain old requests in an approved
maintenance window before applying it, then deploy the compatible server.
Keep the protected database and compatible server for rollback. Do not
restore old grants or replay earlier migrations without a separate reviewed
procedure. Existing staging, job, unit and review records are retained.

Validate in an already authorized isolated environment: roles, direct REST denial,
private-source access, run/SHA mismatch, one-run concurrency, byte and result
integrity, failure, timeout, repeat, prior revisions/review, topic and rights
checks, and end-to-end review/publication. These conditions and an independently
verified secure Lovable secret/deploy mechanism remain release gates. A rollback
turns both cost approvals off and removes the job approval; retain all existing
jobs, units, results and manual decisions. Never revert to Cloud Run. Do not
apply migrations to production until the controlled release is approved.
