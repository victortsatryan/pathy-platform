import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isAnswerCorrect } from "@/lib/answer-check";
import { canReadLessonDetails } from "@/lib/access-control";
import { LESSON_THEORY_MATERIAL_TYPES, getLinkedMaterialIds, materialTopicOrFilter } from "@/lib/extractor/topic-linking";
import { getLessonAttemptsForAssignedTasks, getMissingRequiredTaskIds, isTaskAssignedToLesson } from "@/lib/lesson-security";

function masteryToStatus(score: number): string {
  if (score === 0) return "not_started";
  if (score < 50) return "weak";
  if (score < 70) return "learning";
  if (score < 85) return "stable";
  return "mastered";
}

export const buildLessonFromPathItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ path_item_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;

    const { data: item, error: iErr } = await sb
      .from("learning_path_items")
      .select("*")
      .eq("id", data.path_item_id)
      .eq("user_id", context.userId)
      .single();
    if (iErr) throw new Error(iErr.message);

    // Check if a lesson already exists for this item
    const existing = await sb
      .from("lessons")
      .select("id")
      .eq("learning_path_item_id", data.path_item_id)
      .eq("user_id", context.userId)
      .maybeSingle();
    let lessonId = existing.data?.id as string | undefined;

    if (!lessonId) {
      const ins = await sb
        .from("lessons")
        .insert({
          user_id: context.userId,
          student_profile_id: item.student_profile_id,
          learning_path_id: item.learning_path_id,
          learning_path_item_id: item.id,
          subject_id: item.subject_id,
          topic_id: item.topic_id,
          program_id: item.program_id,
          learning_objective_id: item.learning_objective_id,
          lesson_date: item.planned_date ?? new Date().toISOString().slice(0, 10),
          title: item.title,
          goal: `Закрыть слабую тему: ${item.title}`,
          description: item.description,
          duration_minutes: item.duration_minutes,
        })
        .select("id")
        .single();
      if (ins.error) throw new Error(ins.error.message);
      lessonId = ins.data.id;
    }

    // Get mastery for this topic
    let mastery = 0;
    if (item.topic_id) {
      const { data: prog } = await sb
        .from("student_topic_progress")
        .select("mastery_score")
        .eq("student_profile_id", item.student_profile_id)
        .eq("topic_id", item.topic_id)
        .maybeSingle();
      mastery = prog?.mastery_score ?? 0;
    }

    // ---- Materials: theory first, then practice from the same topic ----
    // The library stores practice items as materials (material_type = 'task'),
    // so a lesson mixes explanation + exercises instead of coming out empty.
    const theoryCount = mastery < 30 ? 3 : mastery < 70 ? 2 : 1;
    const practiceCount = mastery < 30 ? 3 : mastery < 70 ? 5 : 6;

    const picked: { id: string }[] = [];
    if (item.topic_id) {
      const linkedIds = await getLinkedMaterialIds(sb, item.topic_id);
      const topicFilter = materialTopicOrFilter(item.topic_id, linkedIds);
      const [{ data: theory }, { data: practice }] = await Promise.all([
        sb
          .from("materials")
          .select("id, difficulty")
          .or(topicFilter)
          .eq("status", "published")
          .eq("is_public", true)
          .eq("subject_id", item.subject_id)
          .in("material_type", [...LESSON_THEORY_MATERIAL_TYPES])
          .order("difficulty", { ascending: true, nullsFirst: true })
          .limit(theoryCount),
        sb
          .from("materials")
          .select("id, difficulty")
          .or(topicFilter)
          .eq("status", "published")
          .eq("is_public", true)
          .eq("subject_id", item.subject_id)
          .in("material_type", ["task", "practice", "exercise_set", "test"])
          .order("difficulty", { ascending: true, nullsFirst: true })
          .limit(practiceCount),
      ]);
      picked.push(...(theory ?? []), ...(practice ?? []));
      // No subject-level fallback on purpose: a lesson for "Задание N ЕГЭ" must
      // only contain content of that exact topic, otherwise the student gets
      // irrelevant material.
    }


    if (picked.length > 0) {
      const rows = picked.map((m: any, i: number) => ({
        lesson_id: lessonId!,
        material_id: m.id,
        order_index: i,
        is_required: i === 0,
        user_id: context.userId,
      }));
      const materialsUpsert = await (supabaseAdmin as any)
        .from("lesson_materials")
        .upsert(rows, { onConflict: "lesson_id,material_id" });
      if (materialsUpsert.error) throw new Error(materialsUpsert.error.message);
    }

    // ---- Interactive tasks (auto-checked) ----
    const taskCount = mastery < 30 ? 4 : mastery < 70 ? 6 : 4;
    const { data: tasks } = item.topic_id
      ? await sb
          .from("tasks")
          .select("id")
          .eq("topic_id", item.topic_id)
          .eq("is_published", true)
          .limit(taskCount)
      : { data: [] as { id: string }[] };

    if ((tasks ?? []).length > 0) {
      const rows = tasks!.map((t: any, i: number) => ({
        lesson_id: lessonId!,
        task_id: t.id,
        order_index: i,
        points: 1,
        is_required: true,
        user_id: context.userId,
      }));
      const tasksUpsert = await (supabaseAdmin as any)
        .from("lesson_tasks")
        .upsert(rows, { onConflict: "lesson_id,task_id" });
      if (tasksUpsert.error) throw new Error(tasksUpsert.error.message);
    }

    return { lesson_id: lessonId, materials: picked.length, tasks: tasks?.length ?? 0 };
  });

export const getLessonDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ lesson_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const lessonRes = await sb.from("lessons")
      .select("*, subjects(name), topics(title, description)")
      .eq("id", data.lesson_id)
      .single();
    if (lessonRes.error) throw new Error(lessonRes.error.message);

    const viewerIsOwner = lessonRes.data.user_id === context.userId;
    let hasActiveTeacherLink = false;
    if (!viewerIsOwner) {
      const { data: linked, error } = await (sb as any).rpc("can_teacher_view_lesson", {
        _lesson_id: data.lesson_id,
      });
      if (error) throw new Error(error.message);
      hasActiveTeacherLink = linked === true;
    }
    if (!canReadLessonDetails({
      viewerId: context.userId,
      ownerId: lessonRes.data.user_id,
      hasActiveTeacherLink,
    })) throw new Error("Forbidden");

    const [matsRes, tasksRes, resultRes, attemptsRes] = await Promise.all([
      sb.from("lesson_materials")
        .select("id, order_index, is_required, materials(id, title, description, material_type, source_name, source_url, video_url, difficulty, estimated_time_minutes, content_text)")
        .eq("lesson_id", data.lesson_id)
        .order("order_index"),
      sb.from("lesson_tasks")
        .select("id, order_index, points, is_required, tasks(id, title, prompt, task_type, difficulty, options)")
        .eq("lesson_id", data.lesson_id)
        .order("order_index"),
      sb.from("lesson_results").select("*").eq("lesson_id", data.lesson_id).maybeSingle(),
      sb.from("task_attempts").select("task_id, is_correct, student_answer, mistake_type, validated_by_server")
        .eq("lesson_id", data.lesson_id),
    ]);
    for (const result of [matsRes, tasksRes, resultRes, attemptsRes]) {
      if (result.error) throw new Error(result.error.message);
    }

    const revealableTaskIds = [...new Set(
      (attemptsRes.data ?? [])
        .filter((attempt: any) => attempt.validated_by_server && attempt.task_id)
        .map((attempt: any) => attempt.task_id as string),
    )];
    const answerRows = revealableTaskIds.length > 0
      ? await (supabaseAdmin as any)
          .from("task_attempts")
          .select("task_id, correct_answer, tasks(explanation)")
          .eq("lesson_id", data.lesson_id)
          .eq("user_id", lessonRes.data.user_id)
          .eq("validated_by_server", true)
          .in("task_id", revealableTaskIds)
      : { data: [], error: null };
    if (answerRows.error) throw new Error(answerRows.error.message);
    const answerByTaskId = new Map<string, { correct_answer: unknown; explanation: string | null }>();
    for (const attempt of answerRows.data ?? []) {
      answerByTaskId.set(attempt.task_id, {
        correct_answer: attempt.correct_answer,
        explanation: attempt.tasks?.explanation ?? null,
      });
    }
    const attempts = (attemptsRes.data ?? []).filter(
      (attempt: any) => attempt.validated_by_server || lessonRes.data.status === "completed",
    ).map((attempt: any) => {
      const answer = attempt.validated_by_server ? answerByTaskId.get(attempt.task_id) : undefined;
      return {
        ...attempt,
        correct_answer: answer?.correct_answer ?? null,
        explanation: answer?.explanation ?? null,
      };
    });

    // Mastery context
    let mastery = 0;
    if (lessonRes.data?.topic_id && lessonRes.data?.student_profile_id) {
      const { data: prog } = await sb
        .from("student_topic_progress")
        .select("mastery_score, status, mistakes_count")
        .eq("student_profile_id", lessonRes.data.student_profile_id)
        .eq("topic_id", lessonRes.data.topic_id)
        .maybeSingle();
      mastery = prog?.mastery_score ?? 0;
      (lessonRes.data as any).__progress = prog;
    }

    // Next not-completed step of the same learning path (for "next lesson").
    let nextPathItemId: string | null = null;
    const pathItemId = lessonRes.data?.learning_path_item_id as string | null;
    const pathId = lessonRes.data?.learning_path_id as string | null;
    if (pathId) {
      const { data: items } = await sb
        .from("learning_path_items")
        .select("id, status, order_index")
        .eq("learning_path_id", pathId)
        .order("order_index", { ascending: true });
      const list = items ?? [];
      const curIdx = list.findIndex((i: any) => i.id === pathItemId);
      const next = list.slice(curIdx + 1).find((i: any) => i.status !== "completed")
        ?? list.find((i: any) => i.id !== pathItemId && i.status !== "completed");
      nextPathItemId = next?.id ?? null;
    }

    return {
      lesson: lessonRes.data,
      materials: matsRes.data ?? [],
      tasks: tasksRes.data ?? [],
      result: resultRes.data,
      attempts,
      mastery,
      next_path_item_id: nextPathItemId,
      viewer_is_owner: viewerIsOwner,
    };
  });

const submitSchema = z.object({
  lesson_id: z.string().uuid(),
  task_id: z.string().uuid(),
  student_answer: z.string().max(2000),
});

export const submitLessonTaskAttempt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => submitSchema.parse(d))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const lessonRes = await sb.from("lessons")
      .select("student_profile_id, subject_id, topic_id, user_id, status")
      .eq("id", data.lesson_id)
      .single();
    if (lessonRes.error) throw new Error(lessonRes.error.message);
    if (lessonRes.data.user_id !== context.userId) throw new Error("Forbidden");

    const { data: lessonTask, error: linkError } = await sb
      .from("lesson_tasks")
      .select("task_id")
      .eq("lesson_id", data.lesson_id)
      .eq("task_id", data.task_id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (linkError) throw new Error(linkError.message);
    if (!lessonTask || !isTaskAssignedToLesson([lessonTask.task_id], data.task_id)) {
      throw new Error("Задание не входит в это занятие.");
    }

    if (data.student_answer.trim() === "") throw new Error("Введите ответ");

    // An answer is final: repeated submits (double click, navigation) return the stored result.
    const { data: existing, error: existingError } = await (supabaseAdmin as any)
      .from("task_attempts")
      .select("id, is_correct, correct_answer")
      .eq("user_id", context.userId)
      .eq("lesson_id", data.lesson_id)
      .eq("task_id", data.task_id)
      .eq("validated_by_server", true)
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);
    if (existing?.id) {
      return { is_correct: !!existing.is_correct, correct_answer: existing.correct_answer, already_submitted: true };
    }

    if (lessonRes.data.status === "completed") throw new Error("Занятие уже завершено.");

    const taskRes = await (supabaseAdmin as any)
      .from("tasks")
      .select("correct_answer, answer_type, subject_id, topic_id, learning_objective_id")
      .eq("id", lessonTask.task_id)
      .eq("is_published", true)
      .single();
    if (taskRes.error) throw new Error(taskRes.error.message);

    const isCorrect = isAnswerCorrect(taskRes.data.correct_answer, data.student_answer) === true;

    const row = {
      user_id: context.userId,
      student_profile_id: lessonRes.data.student_profile_id,
      lesson_id: data.lesson_id,
      task_id: data.task_id,
      task_key: data.task_id,
      subject_id: taskRes.data.subject_id,
      topic_id: taskRes.data.topic_id,
      learning_objective_id: taskRes.data.learning_objective_id,
      student_answer: data.student_answer as any,
      correct_answer: taskRes.data.correct_answer,
      is_correct: isCorrect,
      points_awarded: isCorrect ? 1 : 0,
      max_points: 1,
      checked_by: "auto",
      mistake_type: isCorrect ? null : "careless_error",
    };

    const ins = await (supabaseAdmin as any)
      .from("task_attempts")
      .insert({ ...row, validated_by_server: true, checked_by: "pathy-server-v1" });
    if (ins.error) {
      // A concurrent request can insert after the initial read. The partial
      // unique index identifies the winning submission, whose result must be
      // returned unchanged, even when the retry supplied a different answer.
      if (ins.error.code === "23505") {
        const { data: winner, error: winnerError } = await (supabaseAdmin as any)
          .from("task_attempts")
          .select("is_correct, correct_answer")
          .eq("user_id", context.userId)
          .eq("lesson_id", data.lesson_id)
          .eq("task_id", data.task_id)
          .eq("validated_by_server", true)
          .maybeSingle();
        if (winnerError) throw new Error(winnerError.message);
        if (winner) return { is_correct: !!winner.is_correct, correct_answer: winner.correct_answer, already_submitted: true };
      }
      throw new Error(ins.error.message);
    }

    return { is_correct: isCorrect, correct_answer: taskRes.data.correct_answer, already_submitted: false };
  });

export const completeLesson = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ lesson_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;

    const { data: lesson, error: lErr } = await sb
      .from("lessons")
      .select("id, user_id, student_profile_id, subject_id, topic_id, learning_path_item_id, status")
      .eq("id", data.lesson_id)
      .single();
    if (lErr) throw new Error(lErr.message);
    if (lesson.user_id !== context.userId) throw new Error("Forbidden");
    if (lesson.status === "completed") {
      const { data: savedResult, error } = await sb
        .from("lesson_results")
        .select("score, max_score, score_percent, summary")
        .eq("lesson_id", data.lesson_id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (savedResult) {
        return {
          score: savedResult.score,
          max: savedResult.max_score,
          percent: savedResult.score_percent,
          summary: savedResult.summary ?? "Занятие уже завершено.",
          already_completed: true,
        };
      }
      throw new Error("Занятие помечено завершённым без результата; требуется проверка администратора.");
    }
    if (!lesson.student_profile_id) throw new Error("Lesson missing student_profile_id");
    const profileId = lesson.student_profile_id as string;

    const [{ data: lessonTasks, error: tasksError }, { data: materialRows, error: materialsError }, { data: allAttempts, error: attemptsError }] = await Promise.all([
      sb.from("lesson_tasks").select("task_id, is_required").eq("lesson_id", data.lesson_id).eq("user_id", context.userId),
      sb.from("lesson_materials").select("id").eq("lesson_id", data.lesson_id).eq("user_id", context.userId),
      sb.from("task_attempts")
        .select("is_correct, points_awarded, max_points, task_id, mistake_type, validated_by_server")
        .eq("lesson_id", data.lesson_id),
    ]);
    if (tasksError) throw new Error(tasksError.message);
    if (materialsError) throw new Error(materialsError.message);
    if (attemptsError) throw new Error(attemptsError.message);
    const assignedTaskIds = (lessonTasks ?? []).map((task: any) => task.task_id as string);
    const requiredTaskIds = (lessonTasks ?? [])
      .filter((task: any) => task.is_required)
      .map((task: any) => task.task_id as string);
    const attempts = getLessonAttemptsForAssignedTasks(assignedTaskIds, allAttempts ?? []);
    const missingRequiredTaskIds = getMissingRequiredTaskIds(
      requiredTaskIds,
      attempts.map((attempt: any) => attempt.task_id as string | null),
    );

    // Optional tasks and standalone theory are allowed; an empty lesson is not.
    if (assignedTaskIds.length === 0 && (materialRows?.length ?? 0) === 0) {
      throw new Error("В занятии нет материалов — завершить его нельзя.");
    }
    if (missingRequiredTaskIds.length > 0) {
      throw new Error("Ответьте на все задания перед завершением.");
    }

    const completed = attempts?.length ?? 0;
    const correct = attempts?.filter((a: any) => a.is_correct).length ?? 0;
    const wrong = completed - correct;
    const score = (attempts ?? []).reduce((s: number, a: any) => s + (a.points_awarded ?? 0), 0);
    const max = (attempts ?? []).reduce((s: number, a: any) => s + (a.max_points ?? 1), 0);
    const percent = max > 0 ? Math.round((score / max) * 100) : 0;

    const summary =
      completed === 0
        ? "Теория изучена. Автоматически проверяемых заданий в занятии не было, поэтому уровень освоения темы не изменился."
        : percent < 50
          ? "Результат низкий. Рекомендуется повторить теорию и выполнить дополнительные задания по этой теме."
          : percent < 80
            ? "Хороший результат. Закрепите тему ещё одной практикой."
            : "Отличный результат. Можно переходить к следующей теме.";

    // Upsert lesson_result
    const { data: existing } = await (supabaseAdmin as any)
      .from("lesson_results")
      .select("id")
      .eq("lesson_id", data.lesson_id)
      .maybeSingle();
    const row = {
      lesson_id: data.lesson_id,
      student_profile_id: profileId,
      user_id: context.userId,
      score,
      max_score: max,
      score_percent: percent,
      completed_tasks: completed,
      correct_tasks: correct,
      wrong_tasks: wrong,
      summary,
    };
    if (existing?.id) {
      const upd = await (supabaseAdmin as any).from("lesson_results").update(row).eq("id", existing.id);
      if (upd.error) throw new Error(`lesson_results update: ${upd.error.message}`);
    } else {
      const ins = await (supabaseAdmin as any).from("lesson_results").insert(row);
      if (ins.error) throw new Error(`lesson_results insert: ${ins.error.message}`);
    }

    // Update progress for the topic
    if (lesson.topic_id && completed > 0) {
      const { data: prog } = await sb
        .from("student_topic_progress")
        .select("id, diagnostic_score, practice_score, attempts_count, mistakes_count, mastery_score")
        .eq("student_profile_id", profileId)
        .eq("topic_id", lesson.topic_id)
        .maybeSingle();

      const newPractice = percent;
      const diag = prog?.diagnostic_score ?? null;
      const newMastery = diag != null ? Math.round(diag * 0.5 + newPractice * 0.5) : newPractice;
      const oldMastery = prog?.mastery_score ?? 0;

      const upsertProg = await sb.from("student_topic_progress").upsert(
        {
          student_profile_id: profileId,
          subject_id: lesson.subject_id,
          topic_id: lesson.topic_id,
          practice_score: newPractice,
          mastery_score: newMastery,
          status: masteryToStatus(newMastery),
          attempts_count: (prog?.attempts_count ?? 0) + completed,
          mistakes_count: (prog?.mistakes_count ?? 0) + wrong,
          last_activity_at: new Date().toISOString(),
        },
        { onConflict: "student_profile_id,topic_id" },
      );
      if (upsertProg.error) throw new Error(`student_topic_progress upsert: ${upsertProg.error.message}`);

      if (oldMastery !== newMastery) {
        await sb.from("student_progress_history").insert({
          student_profile_id: profileId,
          user_id: context.userId,
          subject_id: lesson.subject_id,
          topic_id: lesson.topic_id,
          old_score: oldMastery,
          new_score: newMastery,
          source: "lesson",
          source_ref_id: lesson.id,
        });
      }

      // Save mistakes (mistake_type must match CHECK constraint)
      const allowedMistakes = new Set([
        "concept_gap", "careless_error", "calculation_error", "grammar_error",
        "misread_task", "no_strategy", "vocabulary_gap", "memory_gap", "other",
      ]);
      const wrongAttempts = (attempts ?? []).filter((a: any) => a.is_correct === false);
      if (wrongAttempts.length > 0) {
        const mistakeRows = wrongAttempts.map((a: any) => ({
          student_profile_id: profileId,
          subject_id: lesson.subject_id ?? null,
          topic_id: lesson.topic_id ?? null,
          task_id: a.task_id,
          mistake_type: allowedMistakes.has(a.mistake_type) ? a.mistake_type : "careless_error",
          source: "lesson",
        }));
        const mErr = await sb.from("student_mistakes").insert(mistakeRows);
        if (mErr.error) console.error("student_mistakes insert failed:", mErr.error.message);
      }
    }

    // Mark lesson and path item completed
    const lessonUpdate = await (supabaseAdmin as any)
      .from("lessons")
      .update({ status: "completed" })
      .eq("id", data.lesson_id)
      .eq("user_id", context.userId);
    if (lessonUpdate.error) throw new Error(`lesson completion: ${lessonUpdate.error.message}`);
    if (lesson.learning_path_item_id) {
      await sb.from("learning_path_items").update({ status: "completed" }).eq("id", lesson.learning_path_item_id);
    }
    await sb.from("calendar_events").update({ status: "completed" }).eq("lesson_id", data.lesson_id);

    return { score, max, percent, summary };
  });
