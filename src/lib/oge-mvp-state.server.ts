import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadDefaultMvpState } from "@/lib/oge-mvp-data";

export async function loadMvpStateForUser(userId: string, includeAnswerKeys: boolean) {
  const [resourcesResponse, attemptsResponse, sourcesResponse, overridesResponse] = await Promise.all([
    supabaseAdmin
      .from("content_resources")
      .select("id, title, source_url, difficulty, tasks, content_markdown, video_url, subjects(name), topics(title)")
      .eq("is_published", true)
      .limit(200),
    supabaseAdmin
      .from("task_attempts")
      .select("lesson_id, is_correct, score, submitted_at, subjects(name), topics(title)")
      .eq("user_id", userId)
      .order("submitted_at", { ascending: false })
      .limit(500),
    supabaseAdmin
      .from("learning_sources")
      .select("id, provider, title, url, source_kind, sort_order, subjects(name)")
      .eq("is_published", true)
      .order("sort_order", { ascending: true })
      .limit(200),
    supabaseAdmin
      .from("lesson_overrides")
      .select("lesson_key, title, topic, lesson_date, slot_number, difficulty, status, teacher_note, theory_markdown, tasks")
      .eq("user_id", userId)
      .limit(500),
  ]);

  if (resourcesResponse.error) throw resourcesResponse.error;
  if (attemptsResponse.error) throw attemptsResponse.error;
  if (sourcesResponse.error) throw sourcesResponse.error;
  if (overridesResponse.error) throw overridesResponse.error;

  const solutionTextByResourceId = new Map<string, string | null>();
  if (includeAnswerKeys && (resourcesResponse.data ?? []).length > 0) {
    const { data: solutionRows, error } = await supabaseAdmin
      .from("content_resources")
      .select("id, solution_text")
      .eq("is_published", true)
      .in("id", resourcesResponse.data!.map((resource) => resource.id));
    if (error) throw error;
    for (const row of solutionRows ?? []) solutionTextByResourceId.set(row.id, row.solution_text);
  }

  return loadDefaultMvpState({
    resources: (resourcesResponse.data ?? []).map((resource) => ({
      id: resource.id,
      title: resource.title,
      sourceUrl: resource.source_url,
      difficulty: resource.difficulty,
      subjectName: resource.subjects?.name ?? "",
      topicTitle: resource.topics?.title ?? null,
      tasks: Array.isArray(resource.tasks) ? resource.tasks.map((task: unknown) => String(task)) : [],
      contentMarkdown: resource.content_markdown,
      videoUrl: resource.video_url,
      solutionText: includeAnswerKeys ? solutionTextByResourceId.get(resource.id) ?? null : null,
    })),
    attempts: (attemptsResponse.data ?? []).map((attempt) => ({
      lessonId: attempt.lesson_id,
      subjectName: attempt.subjects?.name ?? "",
      topicTitle: attempt.topics?.title ?? null,
      isCorrect: attempt.is_correct,
      score: attempt.score === null ? null : Number(attempt.score),
      submittedAt: attempt.submitted_at,
    })),
    learningSources: (sourcesResponse.data ?? []).map((source) => ({
      id: source.id,
      subjectName: source.subjects?.name ?? "",
      provider: source.provider,
      title: source.title,
      url: source.url,
      sourceKind: source.source_kind as "theory" | "practice" | "mixed",
    })),
    lessonOverrides: (overridesResponse.data ?? []).map((row) => ({
      lessonKey: row.lesson_key,
      title: row.title,
      topic: row.topic,
      lessonDate: row.lesson_date,
      slotNumber: row.slot_number,
      difficulty: row.difficulty,
      status: row.status,
      teacherNote: row.teacher_note,
      theoryMarkdown: row.theory_markdown,
      tasks: Array.isArray(row.tasks)
        ? row.tasks.map((task, index) => {
            const taskRecord = typeof task === "object" && task !== null && !Array.isArray(task) ? task : {};
            return {
              id: String(taskRecord.id ?? `task-${index + 1}`),
              prompt: String(taskRecord.prompt ?? ""),
              expectedAnswer: includeAnswerKeys ? String(taskRecord.expectedAnswer ?? "") : "",
              explanation: includeAnswerKeys ? String(taskRecord.explanation ?? "") : "",
              sourceLabel: String(taskRecord.sourceLabel ?? ""),
              bankTaskId: taskRecord.bankTaskId ? String(taskRecord.bankTaskId) : null,
            };
          })
        : [],
    })),
  });
}
