# DAT-04: coordinated maintenance rollout

This is **not a zero-downtime rollout**. The old app is incompatible with the
contract permissions and the new app requires the RPCs. The expansion adds
coordination triggers that can also reject old assignment writes. Lovable
editor code, a GitHub commit, preview, and the deployed public revision are
different states; none proves the others. Do not assume Lovable Cloud accepts
selective migrations, exposes a traffic drain, or provides isolated preview
against a separate database. Confirm these capabilities and the actual targets
before scheduling; if any cannot be established, stop and do not release.

## Preflight and maintenance boundary

1. Record the exact currently **deployed** app revision and database project,
   migration ledger, grants and RLS policies; record the tested PR commit and
   establish how to identify the corresponding deployed revision after publish.
   Confirm an independently verified backup and restore plan, and how to keep
   clients out during maintenance. Editor revision alone is not evidence.
2. Rehearse the steps on an isolated database with representative migration
   history and data; preview must be proven to use that database, not the live
   one. Verify access with learner, linked-teacher and admin identities. The
   local PGlite tests cover selected policies and intermediate grants, not a
   live Lovable deployment or all production configuration.
3. Pause **all affected traffic**, including lesson/route opening, assignment,
   task and answer-key reads, attempts and completion, diagnostics, onboarding,
   subject changes, and associated direct API clients and admin flows. Block
   new requests at the actual ingress, not merely the UI. Drain all old app
   instances, retries, in-flight REST/RPC/database requests and background work;
   verify the drain operationally. If that cannot be demonstrated, stop. Keep
   the maintenance boundary in place through the final verification.

## Ordered stages while traffic remains paused

4. Apply schema expansion in migration order: `20261118131500` (column and
   verified-attempt index), `20261118143000` (completion RPC and coordination
   triggers), `20261118144500` (assignment initialization RPC), and
   `20261118150000` (progress/diagnostic RPCs). These files do not revoke old
   grants, but after triggers are installed old app compatibility is not
   guaranteed. Verify migration ledger, function ownership/execute grants and
   expected legacy grants on the isolated target. An old app cannot be resumed
   merely because the expansion did not revoke its permissions.
5. Apply contract migrations `20261118150500` and `20261118151000`. Verify
   learner key access and forged attempt/assignment/progress/history/mistake/
   diagnostic writes are denied, service RPC execution is allowed, and linked
   teacher reads remain available. Direct old service-role result writes must
   be denied. Verify the ledger rather than relying on editor state.
6. Publish the tested application revision via the authorized Lovable release
   process. Independently establish the **deployed public revision** and DB
   target; editor/preview or a successful publish action alone is insufficient.
   If the system cannot prove the revision, keep maintenance in place. While
   ingress stays blocked, use an explicitly controlled verification channel to
   test real authenticated learner, linked teacher and admin flows: existing
   completed lesson opens with assignments/results/history unchanged; empty
   lesson initializes once; attempts and completion work; diagnostic completes
   once; onboarding and skipping diagnostics work; forbidden direct writes and
   answer-key reads fail. Verify rollback on failure and no duplicate progress.
7. Resume affected traffic only after all checks succeed and no old instances
   or requests can return. Capture deployment and migration evidence. If any
   check fails, keep the boundary closed and use the rollback procedure below.

A migration tool that applies every pending file in one operation must run the
whole ordered batch inside the same maintenance boundary. It must not apply the
contract against active old traffic. Confirm how Lovable Cloud migration
application and publish actually behave before relying on this plan; this PR
does not apply or verify either operation in production.

## Failure and rollback

Before contract, do not resume the old server until its compatibility with the
installed triggers has been verified; otherwise keep traffic stopped and use
an independently rehearsed rollback. After contract, keep the protected schema
and return only to a previously tested **compatible** deployed application
revision with all required RPCs. A rollback to an older incompatible app is not
safe with the contract in place. Restoration of old grants/policies is a
separate explicit, approved maintenance decision that reopens the known forgery
and key-exposure risks; it requires the recorded exact pre-release grants and
policies and a tested restoration, followed by validation before traffic. Do not
blindly re-enable access or delete historical data. Preserve and investigate
partial old diagnostic/lesson records; no automatic reconciliation is performed.

## Local verification

```sh
npx vitest run --config vitest.extractor.config.ts
npx vitest run tests/security-pathy-lesson.test.ts
node tests/security-sql-pglite.mjs
node tests/atomic-lesson-pglite.mjs
node tests/lesson-real-schema-pglite.mjs
```

PGlite uses a single connection. `tests/lesson-postgres-concurrency.py` uses an
empty isolated local database named `pathy_test_*` on a Unix socket under
`/tmp/`; generate the schema with `PATHY_TEST_SCHEMA_DUMP=/tmp/pathy-schema.sql
node tests/lesson-real-schema-pglite.mjs` and set `PATHY_TEST_PSQL`,
`PATHY_TEST_PG_SOCKET`, `PATHY_TEST_PG_PORT`, and `PATHY_TEST_PG_DATABASE`.
The dump creates roles and schema; never apply it to a shared database.
