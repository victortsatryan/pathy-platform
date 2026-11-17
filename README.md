# Pathy Platform

Educational application: student, teacher and administrator interfaces, learning logic, Supabase data access, and the TypeScript side of content intake and publication. The Python extractor and private source corpus live in [`pathy-content-pipeline`](https://github.com/victortsatryan/pathy-content-pipeline). Both repositories are components of one Pathy product.

## Engineering baseline

`main` is the integrated application baseline. Start work from its current SHA on a task branch, run the checks below, open a PR to `main`, and merge only after review and CI. Do not infer the published Lovable revision from GitHub `main`: compare the Lovable project commit and deployed revision separately.

The five governing documents are in the private pipeline repository at [`main/docs/pathy`](https://github.com/victortsatryan/pathy-content-pipeline/tree/main/docs/pathy). Read `PATHY_STATE.md`, the relevant `PATHY_BACKLOG.md` item and `PATHY_DECISIONS.md` before changing behavior. Keep private corpus files, answer keys, review images and internal governing documents out of this public repository.

## Local checks

Use Node.js 22 and the committed lockfile:

```bash
npm ci --legacy-peer-deps --no-audit --no-fund
npx vitest run --config vitest.extractor.config.ts
npx tsr generate
npx tsc -b --noEmit
npm run build
```

The GitHub workflow runs these checks on PRs to `main` and pushes to `main`. A successful build does not verify a deployed user flow or Supabase role boundaries.

## Content boundary

Python owns extraction, immutable source observations, source identity, quality evidence and separated student/teacher output. Platform owns intake validation, rights and editorial decisions, mapping to approved curriculum, publication, and use in learning. Today the batch importer and HTTP Worker job path are distinct. The Worker remains transitional until one source-bound intake is verified end to end under `EXT-02` and `LIB-01`. Do not turn extracted exercise text into graded tasks or create curriculum topics from source headings.

See [`AGENTS.md`](AGENTS.md) for preserved role, history and publication invariants. The existing [`worker contract`](docs/extractor-worker-contract.md) describes the transitional HTTP path; it is not the target for a second pipeline.
