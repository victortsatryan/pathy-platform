-- F05/F06: keep task keys server-side and make lesson completion depend on
-- server-verified attempts for the tasks assigned to that lesson.

ALTER TABLE public.task_attempts
  ADD COLUMN IF NOT EXISTS validated_by_server boolean NOT NULL DEFAULT false;

-- A verified attempt is one per learner/task/lesson. Diagnostic attempts do
-- not have lesson_id and remain outside this uniqueness scope.
CREATE UNIQUE INDEX IF NOT EXISTS task_attempts_one_lesson_task_per_user
  ON public.task_attempts (user_id, lesson_id, task_id)
  WHERE lesson_id IS NOT NULL AND task_id IS NOT NULL AND validated_by_server;
