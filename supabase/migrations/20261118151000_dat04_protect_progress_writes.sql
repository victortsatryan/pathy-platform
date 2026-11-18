-- Contract phase. Apply only after the compatible server is deployed and old
-- diagnostic/onboarding requests have been drained; see rollout instructions.
REVOKE ALL ON TABLE public.student_topic_progress FROM PUBLIC,anon,authenticated;
REVOKE ALL ON TABLE public.student_progress_history FROM PUBLIC,anon,authenticated;
REVOKE ALL ON TABLE public.student_mistakes FROM PUBLIC,anon,authenticated;
REVOKE ALL ON TABLE public.diagnostic_topic_results FROM PUBLIC,anon,authenticated;
GRANT SELECT ON TABLE public.student_topic_progress,public.student_progress_history,
  public.student_mistakes,public.diagnostic_topic_results TO authenticated;
GRANT ALL ON TABLE public.student_topic_progress,public.student_progress_history,
  public.student_mistakes,public.diagnostic_topic_results TO service_role;
DROP POLICY IF EXISTS "stp_insert_own" ON public.student_topic_progress;
DROP POLICY IF EXISTS "stp_update_own" ON public.student_topic_progress;
DROP POLICY IF EXISTS "stp_delete_own" ON public.student_topic_progress;
DROP POLICY IF EXISTS "Students insert own progress history" ON public.student_progress_history;
DROP POLICY IF EXISTS "mistakes_insert_own" ON public.student_mistakes;
DROP POLICY IF EXISTS "mistakes_update_own" ON public.student_mistakes;
DROP POLICY IF EXISTS "mistakes_delete_own" ON public.student_mistakes;
DROP POLICY IF EXISTS "diag_topic_results_modify_own" ON public.diagnostic_topic_results;
