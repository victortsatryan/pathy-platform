-- Expand phase. Only trusted server callers may seed progress or complete a
-- diagnostic. Direct client write grants are removed in the later migration.
CREATE OR REPLACE FUNCTION public.seed_student_progress(
  p_user_id uuid, p_profile_id uuid, p_subject_id uuid, p_program_id uuid, p_topic_ids uuid[]
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.student_profiles WHERE id=p_profile_id AND user_id=p_user_id)
    THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF p_program_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.subject_programs WHERE id=p_program_id AND subject_id=p_subject_id)
    THEN RAISE EXCEPTION 'Program does not belong to subject'; END IF;
  IF p_topic_ids IS NULL OR cardinality(p_topic_ids)>10000 OR EXISTS (
    SELECT 1 FROM unnest(p_topic_ids) AS ids(id)
    WHERE ids.id IS NULL OR NOT EXISTS (SELECT 1 FROM public.topics t WHERE t.id=ids.id AND t.subject_id=p_subject_id
      AND ((p_program_id IS NULL AND t.is_public) OR (p_program_id IS NOT NULL AND EXISTS
        (SELECT 1 FROM public.program_topics pt WHERE pt.program_id=p_program_id AND pt.topic_id=t.id)))))
    THEN RAISE EXCEPTION 'Invalid topic selection'; END IF;
  INSERT INTO public.student_topic_progress(student_profile_id,subject_id,topic_id,program_id,mastery_score)
    SELECT p_profile_id,p_subject_id,id,p_program_id,0 FROM unnest(p_topic_ids) AS ids(id)
    ON CONFLICT(student_profile_id,topic_id) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION public.seed_student_progress(uuid,uuid,uuid,uuid,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.seed_student_progress(uuid,uuid,uuid,uuid,uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_diagnostic_atomic(p_session_id uuid,p_user_id uuid,p_answers jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  s public.diagnostic_sessions%ROWTYPE; a record; tr record; prior public.student_topic_progress%ROWTYPE;
  n integer; distinct_n integer; total_score integer; total_max integer; pct integer;
  old_mastery integer; new_mastery integer; summary_text text;
BEGIN
  SELECT * INTO s FROM public.diagnostic_sessions WHERE id=p_session_id FOR UPDATE;
  IF NOT FOUND OR p_user_id IS NULL OR s.user_id<>p_user_id THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF s.status='completed' THEN RETURN jsonb_build_object('id',s.id,'score',s.score,'max_score',s.max_score,'score_percent',s.score_percent,'summary',s.summary,'status',s.status); END IF;
  IF s.status<>'in_progress' OR s.student_profile_id IS NULL OR NOT EXISTS
    (SELECT 1 FROM public.student_profiles WHERE id=s.student_profile_id AND user_id=p_user_id)
    THEN RAISE EXCEPTION 'Invalid diagnostic session'; END IF;
  IF jsonb_typeof(p_answers)<>'array' OR jsonb_array_length(p_answers)=0 OR jsonb_array_length(p_answers)>500
    THEN RAISE EXCEPTION 'Invalid diagnostic answers'; END IF;
  -- Verify the key/points snapshot used by the server and keep it stable
  -- through commit. Client callers cannot execute this function.
  PERFORM 1 FROM public.diagnostic_test_tasks dt
    WHERE dt.diagnostic_test_id=s.diagnostic_test_id AND dt.task_id IN
      (SELECT x.task_id FROM jsonb_to_recordset(p_answers) AS x(task_id uuid))
    ORDER BY dt.task_id FOR SHARE;
  PERFORM 1 FROM public.tasks t WHERE t.id IN
      (SELECT x.task_id FROM jsonb_to_recordset(p_answers) AS x(task_id uuid))
    ORDER BY t.id FOR SHARE;
  SELECT count(*),count(DISTINCT x.task_id),coalesce(sum(x.points_awarded),0)::integer,coalesce(sum(x.max_points),0)::integer
    INTO n,distinct_n,total_score,total_max
    FROM jsonb_to_recordset(p_answers) AS x(task_id uuid,student_answer text,is_correct boolean,points_awarded integer,max_points integer,mistake_type text,mistake_description text);
  IF n<>distinct_n OR EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_answers) AS x(task_id uuid,student_answer text,is_correct boolean,points_awarded integer,max_points integer,mistake_type text,mistake_description text,answer_key_snapshot jsonb)
    LEFT JOIN public.diagnostic_test_tasks dt ON dt.diagnostic_test_id=s.diagnostic_test_id AND dt.task_id=x.task_id
    LEFT JOIN public.tasks t ON t.id=x.task_id
    WHERE dt.task_id IS NULL OR t.id IS NULL OR t.subject_id<>s.subject_id OR x.max_points IS DISTINCT FROM dt.points
       OR x.answer_key_snapshot IS DISTINCT FROM t.correct_answer
       OR x.points_awarded IS DISTINCT FROM CASE WHEN x.is_correct IS TRUE THEN x.max_points ELSE 0 END
       OR x.max_points<0 OR (x.mistake_type IS NOT NULL AND x.mistake_type NOT IN ('concept_gap','careless_error','calculation_error','grammar_error','misread_task','no_strategy','vocabulary_gap','memory_gap','other')))
    THEN RAISE EXCEPTION 'Invalid diagnostic task or score'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(p_answers) AS x(student_answer text) WHERE nullif(btrim(x.student_answer),'') IS NOT NULL)
    THEN RAISE EXCEPTION 'Нельзя завершить диагностику без ответов'; END IF;
  -- In-progress rows left by the old multi-request path are not safely
  -- attributable. Preserve them for investigation instead of overwriting.
  IF EXISTS (SELECT 1 FROM public.diagnostic_answers WHERE diagnostic_session_id=s.id)
     OR EXISTS (SELECT 1 FROM public.diagnostic_topic_results WHERE diagnostic_session_id=s.id)
    THEN RAISE EXCEPTION 'Найдены частичные результаты диагностики; требуется проверка администратора.'; END IF;
  INSERT INTO public.diagnostic_answers(diagnostic_session_id,task_id,student_answer,is_correct,points_awarded,max_points,checked_by,mistake_type,mistake_description)
    SELECT s.id,x.task_id,x.student_answer,x.is_correct,x.points_awarded,x.max_points,'auto',x.mistake_type,x.mistake_description
    FROM jsonb_to_recordset(p_answers) AS x(task_id uuid,student_answer text,is_correct boolean,points_awarded integer,max_points integer,mistake_type text,mistake_description text);
  FOR tr IN SELECT t.topic_id,sum(x.points_awarded)::integer AS score,sum(x.max_points)::integer AS max_score,
      count(*) FILTER(WHERE x.is_correct IS TRUE)::integer AS correct_count,
      count(*) FILTER(WHERE x.is_correct IS FALSE)::integer AS wrong_count
    FROM jsonb_to_recordset(p_answers) AS x(task_id uuid,is_correct boolean,points_awarded integer,max_points integer)
    JOIN public.tasks t ON t.id=x.task_id WHERE t.topic_id IS NOT NULL GROUP BY t.topic_id ORDER BY t.topic_id
  LOOP
    pct := CASE WHEN tr.max_score>0 THEN round(tr.score::numeric*100/tr.max_score)::integer ELSE 0 END;
    INSERT INTO public.diagnostic_topic_results(diagnostic_session_id,student_profile_id,subject_id,topic_id,score,max_score,score_percent,correct_count,wrong_count,detected_weaknesses)
      VALUES(s.id,s.student_profile_id,s.subject_id,tr.topic_id,tr.score,tr.max_score,pct,tr.correct_count,tr.wrong_count,CASE WHEN tr.wrong_count>0 THEN 'Есть ошибки в теме' ELSE NULL END);
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(s.student_profile_id::text || ':' || tr.topic_id::text,0));
    INSERT INTO public.student_topic_progress(student_profile_id,subject_id,topic_id,program_id)
      VALUES(s.student_profile_id,s.subject_id,tr.topic_id,s.program_id) ON CONFLICT(student_profile_id,topic_id) DO NOTHING;
    SELECT * INTO prior FROM public.student_topic_progress WHERE student_profile_id=s.student_profile_id AND topic_id=tr.topic_id FOR UPDATE;
    old_mastery:=coalesce(prior.mastery_score,0);
    new_mastery:=CASE WHEN prior.practice_score IS NULL THEN pct ELSE round(pct::numeric*.7+prior.practice_score::numeric*.3)::integer END;
    UPDATE public.student_topic_progress SET program_id=s.program_id,diagnostic_score=pct,mastery_score=new_mastery,
      status=CASE WHEN new_mastery=0 THEN 'not_started' WHEN new_mastery<50 THEN 'weak' WHEN new_mastery<70 THEN 'learning' WHEN new_mastery<85 THEN 'stable' ELSE 'mastered' END,
      attempts_count=attempts_count+1,mistakes_count=mistakes_count+tr.wrong_count,last_activity_at=now()
      WHERE student_profile_id=s.student_profile_id AND topic_id=tr.topic_id;
    IF old_mastery<>new_mastery THEN
      INSERT INTO public.student_progress_history(student_profile_id,user_id,subject_id,topic_id,old_score,new_score,source,source_ref_id)
        VALUES(s.student_profile_id,p_user_id,s.subject_id,tr.topic_id,old_mastery,new_mastery,'diagnostic',s.id);
    END IF;
  END LOOP;
  INSERT INTO public.student_mistakes(student_profile_id,subject_id,topic_id,task_id,mistake_type,mistake_description,source)
    SELECT s.student_profile_id,s.subject_id,t.topic_id,x.task_id,x.mistake_type,'Ошибка во входной диагностике','diagnostic'
    FROM jsonb_to_recordset(p_answers) AS x(task_id uuid,is_correct boolean,mistake_type text)
    JOIN public.tasks t ON t.id=x.task_id WHERE x.is_correct IS FALSE AND t.topic_id IS NOT NULL AND x.mistake_type IS NOT NULL;
  pct:=CASE WHEN total_max>0 THEN round(total_score::numeric*100/total_max)::integer ELSE 0 END;
  summary_text:=format('Диагностика завершена: %s из %s (%s%%).',total_score,total_max,pct);
  UPDATE public.diagnostic_sessions SET status='completed',completed_at=now(),score=total_score,max_score=total_max,score_percent=pct,summary=summary_text WHERE id=s.id;
  RETURN jsonb_build_object('id',s.id,'score',total_score,'max_score',total_max,'score_percent',pct,'summary',summary_text,'status','completed');
END $$;
REVOKE ALL ON FUNCTION public.complete_diagnostic_atomic(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_diagnostic_atomic(uuid,uuid,jsonb) TO service_role;
