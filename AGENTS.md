
- Learning path regeneration never deletes lessons/attempts/results: old paths are archived, unfinished lessons become `rescheduled`, their calendar events `cancelled` — keeps student history.
- Authority comes only from `user_roles` (via `assign_self_role`/`has_role`); `profiles.role` is informational (chosen cabinet) — prevents privilege drift.
- Teacher read access to a student's lesson data goes through RLS (`is_teacher_of_student` / `can_teacher_view_lesson`) and the single `/student/lesson/$lessonId` screen in read-only mode — no separate teacher lesson screen.
- Extractor source files go through `extractor_jobs` (unique file SHA, private `extractor-sources` bucket) and a server-only HTTP adapter to an external worker (docs/extractor-worker-contract.md); publication inserts new materials/tasks idempotently with provenance and never updates existing rows — keeps PCS and existing content intact. The older audit-staging JSON tables remain as a separate admin-only archive.
- Extractor v0.6 publishes learning materials only, never graded tasks; result ingestion validates page/unit source identity and contiguous pagination before persistence — prevents cross-source imports and fabricated grading authority.

## Engineering workflow

- This is the public `pathy-platform` repository. Read the five governing documents from the private `pathy-content-pipeline/main/docs/pathy` before a task, especially `PATHY_STATE.md`, the relevant `PATHY_BACKLOG.md` item and `PATHY_DECISIONS.md`. Do not copy their private contents, corpus, answer keys or review artifacts into this repository.
- Use `main` as the integrated code baseline; create a task branch, run the README checks, and merge through a PR. Pin the tested commit and verify the Lovable/deployed revision separately. A passing test, a commit, a deploy and an accepted real scenario are different claims.
- Python extraction and source QA remain in the private pipeline. This repository validates the imported source-bound result, handles rights/review, curriculum links and publication. The batch importer and transitional HTTP Worker path are not yet a single accepted intake; changes to that contract belong to EXT-02/LIB-01, not environment housekeeping.
- Preserve the existing role, lesson history, source identity and idempotency rules above. Do not auto-create topics from book headings or graded tasks from unverified OCR. Do not modify production data or deploy a new revision as a side effect of a repository sync.
