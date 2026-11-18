# DAT-04: safe rollout and rollback

Apply F05/F06 first. Pause and drain old lesson completions before applying
`20261118143000_dat04_atomic_lesson_completion.sql`: the old multi-request
workflow can otherwise continue writing after its first committed operation.
The migration blocks its direct result write. Deploy a server that uses the
atomic lesson RPC before resuming those requests.

For progress protection, apply `20261118150000_dat04_secure_progress_functions.sql`
first. Deploy this PR's server, then drain **all** older server instances and
in-flight diagnostic and onboarding requests before applying
`20261118151000_dat04_protect_progress_writes.sql`. Only then revoke the old
client writes. Verify diagnostic completion, skipping diagnostics, profile
initialization and linked teacher reads. This is a staged rollout, not a claim
that arbitrary old and new versions work together: the new server fails closed
if the expansion is absent, and an old diagnostic request can leave partial
results if it is allowed to run when the final migration revokes its writes.
Keep requests paused if the stages cannot be ordered and drained.

Existing completed lessons and diagnostic results are preserved. An incomplete
lesson with a saved result, a completed lesson without one, or an in-progress
diagnostic with already saved answers or topic results is rejected for
investigation. Do not automatically delete or recalculate historical data.
Progress initialization does not reset an existing topic. The linked teacher's
read policies are retained. The protected tables are progress, progress history,
student mistakes and diagnostic topic results; trusted server functions write
them transactionally.

For rollback after the final migration, keep the protected database and roll
back only to a server revision that supports both secure RPCs. Do not silently
restore the old write grants. If an older incompatible server is essential,
pause affected traffic and explicitly authorize a controlled restoration of the
previous grants and policies; this reopens learner forgery until the secure
server and final migration are restored. Investigate partial records separately;
rollback must not erase or rewrite them.

Run targeted local tests without production credentials:

```sh
npx vitest run --config vitest.extractor.config.ts
npx vitest run tests/security-pathy-lesson.test.ts
node tests/security-sql-pglite.mjs
node tests/atomic-lesson-pglite.mjs
node tests/lesson-real-schema-pglite.mjs
```

PGlite serializes a single connection. For actual lock contention,
`tests/lesson-postgres-concurrency.py` requires an empty local database named
`pathy_test_*` on a Unix socket under `/tmp/`, with schema generated using
`PATHY_TEST_SCHEMA_DUMP=/tmp/pathy-schema.sql node tests/lesson-real-schema-pglite.mjs`.
Set `PATHY_TEST_PSQL`, `PATHY_TEST_PG_SOCKET`, `PATHY_TEST_PG_PORT` and
`PATHY_TEST_PG_DATABASE` for that isolated instance. The dump creates roles
and schema; never apply it to a shared database.
