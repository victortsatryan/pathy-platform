export type LessonTaskAttempt = {
  task_id: string | null;
  is_correct: boolean | null;
  points_awarded: number | null;
  max_points: number | null;
  mistake_type: string | null;
  validated_by_server: boolean;
};

export function isTaskAssignedToLesson(assignedTaskIds: readonly string[], taskId: string): boolean {
  return assignedTaskIds.includes(taskId);
}

export function getMissingRequiredTaskIds(
  requiredTaskIds: readonly string[],
  attemptedTaskIds: readonly (string | null)[],
): string[] {
  const attempted = new Set(attemptedTaskIds.filter((id): id is string => id !== null));
  return requiredTaskIds.filter((id) => !attempted.has(id));
}

export function getLessonAttemptsForAssignedTasks<T extends { task_id: string | null }>(
  assignedTaskIds: readonly string[],
  attempts: readonly (T & { validated_by_server: boolean })[],
): T[] {
  const assigned = new Set(assignedTaskIds);
  return attempts.filter(
    (attempt) =>
      attempt.validated_by_server &&
      attempt.task_id !== null &&
      assigned.has(attempt.task_id),
  );
}
