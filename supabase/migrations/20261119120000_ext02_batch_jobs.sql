-- EXT-02: existing jobs/units remain authoritative; no new queue or DB role.
ALTER TABLE public.extractor_jobs ADD COLUMN IF NOT EXISTS batch_code_sha text;
ALTER TABLE public.extractor_jobs ADD COLUMN IF NOT EXISTS batch_run_id text;
ALTER TABLE public.extractor_jobs ADD COLUMN IF NOT EXISTS batch_approval_id uuid;
ALTER TABLE public.extractor_jobs ADD COLUMN IF NOT EXISTS batch_lease_until timestamptz;

CREATE OR REPLACE FUNCTION public.ext02_reserve_job(p_job uuid,p_user uuid,p_sha text,p_approval uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j public.extractor_jobs%ROWTYPE;
BEGIN
 IF p_user IS NULL OR NOT public.has_role(p_user,'admin'::public.app_role) THEN RAISE EXCEPTION 'Forbidden'; END IF;
 IF p_approval IS NULL OR p_sha IS NULL OR p_sha !~ '^[0-9a-f]{40}$' THEN RAISE EXCEPTION 'Invalid code SHA'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pathy-ext02-single-run',0));
 IF EXISTS (SELECT 1 FROM public.extractor_jobs WHERE batch_code_sha IS NOT NULL AND batch_lease_until>now() AND status IN ('queued','processing')) THEN RAISE EXCEPTION 'Batch busy'; END IF;
 SELECT * INTO j FROM public.extractor_jobs WHERE id=p_job FOR UPDATE;
 IF NOT FOUND OR j.status NOT IN ('uploaded','worker_not_configured','failed') OR j.attempts>=2 OR j.batch_approval_id=p_approval OR j.result IS NOT NULL OR EXISTS (SELECT 1 FROM public.extractor_job_units WHERE job_id=p_job) THEN RAISE EXCEPTION 'Job is not eligible'; END IF;
 UPDATE public.extractor_jobs SET status='queued',stage='awaiting_batch',worker_rule_version='pathy-batch-v1',batch_code_sha=p_sha,batch_run_id=NULL,batch_approval_id=p_approval,batch_lease_until=now()+interval '20 minutes',error=NULL,updated_at=now() WHERE id=p_job;
END $$;

CREATE OR REPLACE FUNCTION public.ext02_claim_job(p_job uuid,p_run text,p_sha text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j public.extractor_jobs%ROWTYPE;
BEGIN
 IF p_run IS NULL OR p_run !~ '^[0-9]{1,30}$' OR p_sha IS NULL THEN RAISE EXCEPTION 'Invalid run'; END IF;
 SELECT * INTO j FROM public.extractor_jobs WHERE id=p_job FOR UPDATE;
 IF NOT FOUND OR j.batch_code_sha IS DISTINCT FROM p_sha OR j.batch_lease_until<=now() OR j.batch_lease_until IS NULL THEN RAISE EXCEPTION 'Job lease unavailable'; END IF;
 IF j.status='processing' AND j.batch_run_id=p_run THEN
   RETURN jsonb_build_object('sha256',j.file_sha256,'filename',j.file_name,'size',j.size_bytes,'storage_path',j.storage_path,'revision',j.revision);
 END IF;
 IF j.status<>'queued' OR j.batch_run_id IS NOT NULL OR j.attempts>=2 THEN RAISE EXCEPTION 'Job already claimed'; END IF;
 UPDATE public.extractor_jobs SET status='processing',stage='extracting',batch_run_id=p_run,attempts=attempts+1,updated_at=now() WHERE id=p_job;
 RETURN jsonb_build_object('sha256',j.file_sha256,'filename',j.file_name,'size',j.size_bytes,'storage_path',j.storage_path,'revision',j.revision);
END $$;

CREATE OR REPLACE FUNCTION public.ext02_complete_job(p_job uuid,p_run text,p_result jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j public.extractor_jobs%ROWTYPE; n integer; distinct_n integer;
BEGIN
 SELECT * INTO j FROM public.extractor_jobs WHERE id=p_job FOR UPDATE;
 IF FOUND AND j.status IN ('succeeded','publishing','published') AND j.batch_run_id=p_run THEN
   IF j.result IS NOT DISTINCT FROM p_result THEN RETURN; END IF;
   RAISE EXCEPTION 'Conflicting completed result';
 END IF;
 IF NOT FOUND OR j.status<>'processing' OR j.batch_run_id IS DISTINCT FROM p_run OR j.batch_lease_until IS NULL OR j.batch_lease_until<=now() THEN RAISE EXCEPTION 'Invalid or expired lease'; END IF;
 IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' OR octet_length(p_result::text)>16000000 OR p_result->>'format' IS DISTINCT FROM 'pathy-extraction-result-v1' OR p_result#>>'{source,sha256}' IS DISTINCT FROM j.file_sha256 OR jsonb_typeof(p_result->'units') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid result'; END IF;
 IF p_result#>>'{pipeline_context,source_sha256}' IS DISTINCT FROM j.file_sha256 OR p_result#>'{pipeline_context,source_original_bytes_verified}' IS DISTINCT FROM 'true'::jsonb OR (p_result#>'{pipeline_context,source_block_linkage_complete}' IS DISTINCT FROM 'true'::jsonb AND NOT (j.batch_run_id='manual' AND p_result#>>'{pipeline_context,mode}' IS NOT DISTINCT FROM 'manual_audit' AND p_result#>'{pipeline_context,source_block_linkage_complete}' IS NOT DISTINCT FROM 'false'::jsonb)) THEN RAISE EXCEPTION 'Incomplete provenance'; END IF;
 n:=jsonb_array_length(p_result->'units');
 IF n<1 OR n>5000 OR (p_result#>>'{summary,total_units}')::integer IS DISTINCT FROM n THEN RAISE EXCEPTION 'Incomplete result'; END IF;
 SELECT count(DISTINCT x->>'unit_id') INTO distinct_n FROM jsonb_array_elements(p_result->'units') x;
 IF distinct_n<>n OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_result->'units') x
    WHERE jsonb_typeof(x)<>'object' OR coalesce(x->>'unit_id','') NOT LIKE 'source:'||j.file_sha256||':unit:%'
       OR x#>>'{source,sha256}' IS DISTINCT FROM j.file_sha256
       OR coalesce(x->>'role','') NOT IN ('student_material','teacher_private')
       OR x->'usable_for_grading' IS DISTINCT FROM 'false'::jsonb
       OR (x->>'role'='teacher_private' AND x->'usable_for_learning' IS DISTINCT FROM 'false'::jsonb)
       OR (j.batch_run_id='manual' AND (x->'usable_for_learning' IS DISTINCT FROM 'false'::jsonb OR x->'requires_manual_review' IS DISTINCT FROM 'true'::jsonb OR x#>>'{source,intake_mode}' IS DISTINCT FROM 'manual_audit'))
       OR (x->'requires_manual_review'='true'::jsonb AND x->'usable_for_learning'='true'::jsonb)) THEN RAISE EXCEPTION 'Invalid unit'; END IF;
 IF j.result IS NOT NULL OR EXISTS (SELECT 1 FROM public.extractor_job_units WHERE job_id=p_job) THEN RAISE EXCEPTION 'Existing result requires review'; END IF;
 INSERT INTO public.extractor_job_units(job_id,unit_id,position,raw)
   SELECT p_job,x->>'unit_id',(ord-1)::integer,x FROM jsonb_array_elements(p_result->'units') WITH ORDINALITY a(x,ord);
 UPDATE public.extractor_jobs SET status='succeeded',stage='completed',progress=100,result=p_result,result_total_units=n,result_summary=p_result->'summary',batch_lease_until=NULL,error=NULL,updated_at=now() WHERE id=p_job;
END $$;

REVOKE ALL ON FUNCTION public.ext02_reserve_job(uuid,uuid,text,uuid),public.ext02_claim_job(uuid,text,text),public.ext02_complete_job(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ext02_reserve_job(uuid,uuid,text,uuid),public.ext02_claim_job(uuid,text,text),public.ext02_complete_job(uuid,text,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.ext02_fail_job(p_job uuid,p_run text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 UPDATE public.extractor_jobs SET status='failed',stage='failed',error='Пакетная обработка завершилась ошибкой',batch_lease_until=NULL,updated_at=now()
 WHERE id=p_job AND status='processing' AND batch_run_id=p_run AND batch_lease_until>now();
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid or expired lease'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.ext02_fail_job(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ext02_fail_job(uuid,text) TO service_role;
CREATE OR REPLACE FUNCTION public.ext02_expire_job(p_job uuid,p_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_user IS NULL OR NOT public.has_role(p_user,'admin'::public.app_role) THEN RAISE EXCEPTION 'Forbidden'; END IF;
 UPDATE public.extractor_jobs SET status='failed',stage='timeout',error='Истёк срок пакетной обработки; проверьте запуск перед созданием новой версии',batch_lease_until=NULL,updated_at=now()
 WHERE id=p_job AND status IN ('queued','processing') AND batch_code_sha IS NOT NULL AND batch_lease_until<=now();
END $$;
REVOKE ALL ON FUNCTION public.ext02_expire_job(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ext02_expire_job(uuid,uuid) TO service_role;

-- Manual audit files use the same immutable result / job units transaction.
-- Only the server can call this after authorizing the admin and re-hashing
-- the stored source. An audit export is NOT source-block-verified.
CREATE OR REPLACE FUNCTION public.ext02_import_audit_result(p_job uuid,p_user uuid,p_result jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j public.extractor_jobs%ROWTYPE;
BEGIN
 IF p_user IS NULL OR NOT public.has_role(p_user,'admin'::public.app_role) THEN RAISE EXCEPTION 'Forbidden'; END IF;
 SELECT * INTO j FROM public.extractor_jobs WHERE id=p_job FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Job not found'; END IF;
 IF j.status IN ('succeeded','publishing','published') AND j.batch_run_id='manual' THEN
   IF j.result IS NOT DISTINCT FROM p_result THEN RETURN; END IF;
   RAISE EXCEPTION 'Conflicting completed result';
 END IF;
 IF j.status NOT IN ('uploaded','worker_not_configured','failed') OR j.result IS NOT NULL OR EXISTS (SELECT 1 FROM public.extractor_job_units WHERE job_id=p_job) THEN RAISE EXCEPTION 'Existing result or active job'; END IF;
 IF p_result#>>'{pipeline_context,mode}' IS DISTINCT FROM 'manual_audit' OR p_result#>'{pipeline_context,source_block_linkage_complete}' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'Invalid audit provenance'; END IF;
 UPDATE public.extractor_jobs SET status='processing',stage='importing_audit',worker_rule_version='pathy-batch-v1',batch_run_id='manual',batch_lease_until=now()+interval '1 minute' WHERE id=p_job;
 PERFORM public.ext02_complete_job(p_job,'manual',p_result);
END $$;
REVOKE ALL ON FUNCTION public.ext02_import_audit_result(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ext02_import_audit_result(uuid,uuid,jsonb) TO service_role;
