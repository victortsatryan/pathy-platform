type LessonCompletionResult = { score: number; max: number; percent: number; summary: string; already_completed: boolean };

/** The caller supplies the authenticated identity, never a client-provided one. */
export async function completeLessonForUser(
  admin: { rpc: (name: string, args: { p_lesson_id: string; p_user_id: string }) => PromiseLike<{ data: unknown; error: { message: string } | null }> },
  userId: string,
  lessonId: string,
): Promise<LessonCompletionResult> {
  const { data, error } = await admin.rpc('complete_lesson_atomic', { p_lesson_id: lessonId, p_user_id: userId });
  if (error) throw new Error(error.message);
  if (!data || typeof data !== 'object') throw new Error('Не удалось завершить занятие.');
  return data as LessonCompletionResult;
}
