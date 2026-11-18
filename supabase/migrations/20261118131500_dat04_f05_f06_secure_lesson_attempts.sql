-- F05/F06: keep task keys server-side and make lesson completion depend on
-- server-verified attempts for the tasks assigned to that lesson.

ALTER TABLE public.task_attempts
  ADD COLUMN IF NOT EXISTS validated_by_server boolean NOT NULL DEFAULT false;

-- A verified attempt is one per learner/task/lesson. Diagnostic attempts do
-- not have lesson_id and remain outside this uniqueness scope.
CREATE UNIQUE INDEX IF NOT EXISTS task_attempts_one_lesson_task_per_user
  ON public.task_attempts (user_id, lesson_id, task_id)
  WHERE lesson_id IS NOT NULL AND task_id IS NOT NULL AND validated_by_server;

-- Authenticated clients may read safe task fields, but only trusted server
-- functions may read answer keys and explanations. Anon receives no access.
REVOKE ALL ON TABLE public.tasks FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, subject_id, program_id, topic_id, learning_objective_id, task_key,
  prompt, answer_type, options, difficulty, exam_section, tags, source_url,
  is_published, created_at, updated_at, estimated_time_minutes,
  exam_task_number, source_name, task_type, title
) ON TABLE public.tasks TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.tasks TO authenticated;
GRANT ALL ON TABLE public.tasks TO service_role;
DROP POLICY IF EXISTS "tasks_admin_insert" ON public.tasks;
DROP POLICY IF EXISTS "tasks admin manage" ON public.tasks;
CREATE POLICY "tasks admin manage" ON public.tasks
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

-- Legacy answer-bearing stores are not client read APIs. The platform routes
-- below them through authenticated server functions that return keys only
-- after submission or to an authorized content administrator.
REVOKE ALL ON TABLE public.content_resources FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.content_resources TO service_role;

REVOKE ALL ON TABLE public.task_solutions FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.task_solutions FROM authenticated;
GRANT SELECT ON TABLE public.task_solutions TO authenticated;
GRANT ALL ON TABLE public.task_solutions TO service_role;
DROP POLICY IF EXISTS "task_solutions read published or own" ON public.task_solutions;
DROP POLICY IF EXISTS "task_solutions read" ON public.task_solutions;
CREATE POLICY "task_solutions owner or admin read" ON public.task_solutions
  FOR SELECT TO authenticated
  USING (created_by = auth.uid() OR public.has_role(auth.uid(), 'admin'::public.app_role));

REVOKE SELECT ON TABLE public.lesson_overrides FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.lesson_overrides TO service_role;

-- The session owner may read their own completed history, but cannot forge a
-- completed session or insert diagnostic answer rows through the REST API.
REVOKE ALL ON TABLE public.diagnostic_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.diagnostic_sessions TO authenticated;
GRANT ALL ON TABLE public.diagnostic_sessions TO service_role;
DROP POLICY IF EXISTS "Users can create their own diagnostics" ON public.diagnostic_sessions;
DROP POLICY IF EXISTS "Users can update their own diagnostics" ON public.diagnostic_sessions;
DROP POLICY IF EXISTS "Users can delete their own diagnostics" ON public.diagnostic_sessions;

REVOKE ALL ON TABLE public.diagnostic_answers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.diagnostic_answers TO authenticated;
GRANT ALL ON TABLE public.diagnostic_answers TO service_role;
DROP POLICY IF EXISTS "diag_answers_modify_own" ON public.diagnostic_answers;

-- Attempts and lesson assignments are written only by authenticated server
-- functions using the service role after checking owner and task membership.
REVOKE ALL ON TABLE public.task_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, user_id, lesson_id, diagnostic_session_id, student_profile_id,
  subject_id, topic_id, task_key, prompt_snapshot, student_answer,
  is_correct, score, feedback, submitted_at, created_at, updated_at,
  learning_objective_id, task_id, points_awarded, max_points, checked_by,
  mistake_type, mistake_description, validated_by_server
) ON TABLE public.task_attempts TO authenticated;
GRANT ALL ON TABLE public.task_attempts TO service_role;
DROP POLICY IF EXISTS "Users can create their own task attempts" ON public.task_attempts;
DROP POLICY IF EXISTS "Users can update their own task attempts" ON public.task_attempts;
DROP POLICY IF EXISTS "Users can delete their own task attempts" ON public.task_attempts;

REVOKE ALL ON TABLE public.lesson_tasks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.lesson_tasks TO authenticated;
GRANT ALL ON TABLE public.lesson_tasks TO service_role;
DROP POLICY IF EXISTS "lt owner all" ON public.lesson_tasks;
CREATE POLICY "lt owner read" ON public.lesson_tasks FOR SELECT TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON TABLE public.lesson_materials FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.lesson_materials TO authenticated;
GRANT ALL ON TABLE public.lesson_materials TO service_role;
DROP POLICY IF EXISTS "lm owner all" ON public.lesson_materials;
CREATE POLICY "lm owner read" ON public.lesson_materials FOR SELECT TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON TABLE public.lesson_results FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.lesson_results TO authenticated;
GRANT ALL ON TABLE public.lesson_results TO service_role;
DROP POLICY IF EXISTS "lr owner all" ON public.lesson_results;
CREATE POLICY "lr owner read" ON public.lesson_results FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Students may create planned lessons, but cannot set status or mutate/delete
-- a lesson directly. State changes remain in server workflows.
ALTER TABLE public.lessons ALTER COLUMN status SET DEFAULT 'planned';
REVOKE ALL ON TABLE public.lessons FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.lessons TO authenticated;
GRANT INSERT (
  user_id, student_profile_id, learning_path_id, learning_path_item_id,
  subject_id, topic_id, program_id, learning_objective_id, lesson_date,
  title, goal, description, duration_minutes
) ON TABLE public.lessons TO authenticated;
GRANT ALL ON TABLE public.lessons TO service_role;
DROP POLICY IF EXISTS "Users can update their own lessons" ON public.lessons;
DROP POLICY IF EXISTS "Users can delete their own lessons" ON public.lessons;
