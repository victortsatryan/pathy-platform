-- Rollout contract: install this migration first. Old servers fail on their
-- first lesson_results write, before they can alter progress; new servers
-- require the RPC and never fall back to the old multi-request sequence.
REVOKE INSERT, UPDATE, DELETE ON public.lesson_results FROM service_role;

CREATE OR REPLACE FUNCTION public.lock_verified_lesson_attempt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE l public.lessons%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.lesson_id IS NOT NULL AND OLD.validated_by_server THEN
      SELECT * INTO l FROM public.lessons WHERE id=OLD.lesson_id FOR UPDATE;
      IF FOUND AND l.status='completed' THEN RAISE EXCEPTION 'Занятие уже завершено.'; END IF;
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD.validated_by_server AND (
    NEW.lesson_id IS DISTINCT FROM OLD.lesson_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NOT NEW.validated_by_server
  ) THEN RAISE EXCEPTION 'Cannot transfer a verified attempt'; END IF;
  IF NEW.lesson_id IS NULL OR NOT NEW.validated_by_server THEN RETURN NEW; END IF;
  SELECT * INTO l FROM public.lessons WHERE id = NEW.lesson_id FOR UPDATE;
  IF NOT FOUND OR l.user_id <> NEW.user_id THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF l.status = 'completed' THEN RAISE EXCEPTION 'Занятие уже завершено.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lesson_tasks lt WHERE lt.lesson_id = l.id
                 AND lt.task_id = NEW.task_id AND lt.user_id = l.user_id) THEN
    RAISE EXCEPTION 'Задание не входит в это занятие.';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.lock_verified_lesson_attempt() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER lock_verified_lesson_attempt_before_change
BEFORE INSERT OR UPDATE OR DELETE ON public.task_attempts FOR EACH ROW EXECUTE FUNCTION public.lock_verified_lesson_attempt();

-- Assignment changes must not race the completion snapshot. A cascade caused
-- by deleting the parent is allowed when the parent has already disappeared.
CREATE OR REPLACE FUNCTION public.lock_lesson_assignment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE lesson_uuid uuid; l public.lessons%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.lesson_id IS DISTINCT FROM NEW.lesson_id OR OLD.user_id IS DISTINCT FROM NEW.user_id) THEN
    RAISE EXCEPTION 'Cannot transfer lesson assignment';
  END IF;
  lesson_uuid := CASE WHEN TG_OP='DELETE' THEN OLD.lesson_id ELSE NEW.lesson_id END;
  SELECT * INTO l FROM public.lessons WHERE id=lesson_uuid FOR UPDATE;
  IF NOT FOUND THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Lesson not found';
  END IF;
  IF l.status='completed' THEN RAISE EXCEPTION 'Занятие уже завершено.'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.user_id <> l.user_id THEN RAISE EXCEPTION 'Forbidden'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.lock_lesson_assignment() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER lock_lesson_tasks_before_change BEFORE INSERT OR UPDATE OR DELETE ON public.lesson_tasks
FOR EACH ROW EXECUTE FUNCTION public.lock_lesson_assignment();
CREATE TRIGGER lock_lesson_materials_before_change BEFORE INSERT OR UPDATE OR DELETE ON public.lesson_materials
FOR EACH ROW EXECUTE FUNCTION public.lock_lesson_assignment();

CREATE OR REPLACE FUNCTION public.complete_lesson_atomic(p_lesson_id uuid, p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  l public.lessons%ROWTYPE; existing public.lesson_results%ROWTYPE;
  completed_count integer; correct_count integer; wrong_count integer;
  total_score integer; total_max integer; percent_score integer; msg text;
  prior public.student_topic_progress%ROWTYPE; old_mastery integer; new_mastery integer;
BEGIN
  SELECT * INTO l FROM public.lessons WHERE id=p_lesson_id FOR UPDATE;
  IF NOT FOUND OR l.user_id <> p_user_id OR p_user_id IS NULL THEN RAISE EXCEPTION 'Forbidden'; END IF;
  SELECT * INTO existing FROM public.lesson_results WHERE lesson_id=l.id;
  IF existing.id IS NOT NULL AND existing.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'Несогласованный владелец результата; требуется проверка администратора.';
  END IF;
  IF l.status='completed' THEN
    IF existing.id IS NULL THEN RAISE EXCEPTION 'Занятие помечено завершённым без результата; требуется проверка администратора.'; END IF;
    RETURN jsonb_build_object('score',existing.score,'max',existing.max_score,'percent',existing.score_percent,
      'summary',coalesce(existing.summary,'Занятие уже завершено.'),'already_completed',true);
  END IF;
  IF existing.id IS NOT NULL THEN RAISE EXCEPTION 'Найден результат незавершённого занятия; требуется проверка администратора.'; END IF;
  IF l.student_profile_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.student_profiles sp WHERE sp.id=l.student_profile_id AND sp.user_id=p_user_id)
    THEN RAISE EXCEPTION 'Lesson missing owned student profile'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lesson_tasks WHERE lesson_id=l.id AND user_id=p_user_id)
     AND NOT EXISTS (SELECT 1 FROM public.lesson_materials WHERE lesson_id=l.id AND user_id=p_user_id)
    THEN RAISE EXCEPTION 'В занятии нет материалов — завершить его нельзя.'; END IF;
  IF EXISTS (SELECT 1 FROM public.lesson_tasks lt WHERE lt.lesson_id=l.id AND lt.user_id=p_user_id AND lt.is_required
     AND NOT EXISTS (SELECT 1 FROM public.task_attempts a WHERE a.lesson_id=l.id AND a.user_id=p_user_id
                     AND a.task_id=lt.task_id AND a.validated_by_server))
    THEN RAISE EXCEPTION 'Ответьте на все задания перед завершением.'; END IF;
  SELECT count(*)::integer, count(*) FILTER (WHERE a.is_correct IS TRUE)::integer,
         coalesce(sum(a.points_awarded),0)::integer, coalesce(sum(a.max_points),0)::integer
    INTO completed_count,correct_count,total_score,total_max
    FROM public.task_attempts a JOIN public.lesson_tasks lt ON lt.lesson_id=a.lesson_id AND lt.task_id=a.task_id AND lt.user_id=p_user_id
    WHERE a.lesson_id=l.id AND a.user_id=p_user_id AND a.validated_by_server;
  wrong_count := completed_count-correct_count;
  percent_score := CASE WHEN total_max>0 THEN round(total_score::numeric*100/total_max)::integer ELSE 0 END;
  msg := CASE WHEN completed_count=0 THEN 'Теория изучена. Автоматически проверяемых заданий в занятии не было, поэтому уровень освоения темы не изменился.'
              WHEN percent_score<50 THEN 'Результат низкий. Рекомендуется повторить теорию и выполнить дополнительные задания по этой теме.'
              WHEN percent_score<80 THEN 'Хороший результат. Закрепите тему ещё одной практикой.'
              ELSE 'Отличный результат. Можно переходить к следующей теме.' END;
  INSERT INTO public.lesson_results (lesson_id,student_profile_id,user_id,score,max_score,score_percent,completed_tasks,correct_tasks,wrong_tasks,summary)
    VALUES(l.id,l.student_profile_id,p_user_id,total_score,total_max,percent_score,completed_count,correct_count,wrong_count,msg);
  IF l.topic_id IS NOT NULL AND completed_count>0 THEN
    -- Serialize different lessons for the same topic, including the first insert.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(l.student_profile_id::text || ':' || l.topic_id::text,0));
    INSERT INTO public.student_topic_progress(student_profile_id,subject_id,topic_id)
      VALUES(l.student_profile_id,l.subject_id,l.topic_id)
      ON CONFLICT(student_profile_id,topic_id) DO NOTHING;
    SELECT * INTO prior FROM public.student_topic_progress WHERE student_profile_id=l.student_profile_id AND topic_id=l.topic_id FOR UPDATE;
    old_mastery := coalesce(prior.mastery_score,0);
    new_mastery := CASE WHEN prior.diagnostic_score IS NULL THEN percent_score ELSE round((prior.diagnostic_score+percent_score)::numeric/2)::integer END;
    UPDATE public.student_topic_progress SET practice_score=percent_score,mastery_score=new_mastery,
      status=CASE WHEN new_mastery=0 THEN 'not_started' WHEN new_mastery<50 THEN 'weak' WHEN new_mastery<70 THEN 'learning' WHEN new_mastery<85 THEN 'stable' ELSE 'mastered' END,
      attempts_count=attempts_count+completed_count,mistakes_count=mistakes_count+wrong_count,last_activity_at=now()
      WHERE student_profile_id=l.student_profile_id AND topic_id=l.topic_id;
    IF old_mastery<>new_mastery THEN
      INSERT INTO public.student_progress_history(student_profile_id,user_id,subject_id,topic_id,old_score,new_score,source,source_ref_id)
      VALUES(l.student_profile_id,p_user_id,l.subject_id,l.topic_id,old_mastery,new_mastery,'lesson',l.id);
    END IF;
    INSERT INTO public.student_mistakes(student_profile_id,subject_id,topic_id,task_id,mistake_type,source)
      SELECT l.student_profile_id,l.subject_id,l.topic_id,a.task_id,
        CASE WHEN a.mistake_type IN ('concept_gap','careless_error','calculation_error','grammar_error','misread_task','no_strategy','vocabulary_gap','memory_gap','other') THEN a.mistake_type ELSE 'careless_error' END,'lesson'
      FROM public.task_attempts a JOIN public.lesson_tasks lt ON lt.lesson_id=a.lesson_id AND lt.task_id=a.task_id AND lt.user_id=p_user_id
      WHERE a.lesson_id=l.id AND a.user_id=p_user_id AND a.validated_by_server AND a.is_correct IS FALSE;
  END IF;
  UPDATE public.lessons SET status='completed' WHERE id=l.id AND user_id=p_user_id;
  IF l.learning_path_item_id IS NOT NULL THEN
    UPDATE public.learning_path_items SET status='completed' WHERE id=l.learning_path_item_id AND user_id=p_user_id;
  END IF;
  UPDATE public.calendar_events SET status='completed' WHERE lesson_id=l.id AND user_id=p_user_id;
  RETURN jsonb_build_object('score',total_score,'max',total_max,'percent',percent_score,'summary',msg,'already_completed',false);
END $$;
REVOKE ALL ON FUNCTION public.complete_lesson_atomic(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_lesson_atomic(uuid,uuid) TO service_role;
