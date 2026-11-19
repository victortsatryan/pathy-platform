-- Historic audit-staging rows remain readable; new imports must use job units.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.extractor_staging_units FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS extractor_staging_admin_insert ON public.extractor_staging_units;

-- Raw source/results and review provenance are mutated only by authorized
-- server handlers and the service-only transaction, never via direct REST.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.extractor_jobs FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.extractor_job_units FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS extractor_jobs_admin_insert ON public.extractor_jobs;
DROP POLICY IF EXISTS extractor_jobs_admin_update ON public.extractor_jobs;
DROP POLICY IF EXISTS extractor_job_units_admin_insert ON public.extractor_job_units;
DROP POLICY IF EXISTS extractor_job_units_admin_update ON public.extractor_job_units;
