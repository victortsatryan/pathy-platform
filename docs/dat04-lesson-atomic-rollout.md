# DAT-04: lesson completion rollout

This change requires the F05/F06 migration and then the atomic completion
migration before the matching server code. The new server fails closed when
the RPC is absent; it has no fallback to the old sequence of writes.

Before applying the atomic migration, pause and drain old lesson completion
requests. A request that has already committed its result in a previous HTTP
operation can otherwise continue its remaining old writes after the migration.
With that drain completed, the migration removes direct service-role writes to
`lesson_results`, so old servers fail at their first result write. Deploy the
new server and verify it before resuming completion requests. This is a brief
availability interruption, not an online mixed-version guarantee.

Completed lessons with saved results retain their result. An unfinished lesson
with an existing result, or a completed lesson without one, is rejected for
administrator investigation; the migration does not delete, recalculate or
automatically adopt these historical rows. Unverified historical attempts are
preserved and cannot satisfy a required task. A new trusted attempt is separate.

Run local tests without production credentials:

```sh
npx vitest run --config vitest.extractor.config.ts
npx vitest run tests/security-pathy-lesson.test.ts
node tests/security-sql-pglite.mjs
node tests/atomic-lesson-pglite.mjs
node tests/lesson-real-schema-pglite.mjs
```

PGlite serializes a single connection. For actual lock contention, the
separate `tests/lesson-postgres-concurrency.py` requires an empty local test
database named `pathy_test_*` on a Unix socket under `/tmp/`, with the schema
from `PATHY_TEST_SCHEMA_DUMP=/tmp/pathy-schema.sql node
tests/lesson-real-schema-pglite.mjs`. Set `PATHY_TEST_PSQL`,
`PATHY_TEST_PG_SOCKET`, `PATHY_TEST_PG_PORT` and `PATHY_TEST_PG_DATABASE` to
the isolated instance before running it. The dump creates roles and schema;
never apply it to a shared database.
