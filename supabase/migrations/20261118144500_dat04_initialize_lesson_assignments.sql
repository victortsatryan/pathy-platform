-- Initialize an empty lesson once, under the same row lock as completion.
-- Reopening never replaces or adds to an existing assignment set.
CREATE OR REPLACE FUNCTION public.initialize_lesson_assignments(
  p_lesson_id uuid, p_user_id uuid, p_material_ids uuid[], p_task_ids uuid[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE l public.lessons%ROWTYPE; material_count integer; task_count integer;
BEGIN
  SELECT * INTO l FROM public.lessons WHERE id=p_lesson_id FOR UPDATE;
  IF NOT FOUND OR p_user_id IS NULL OR l.user_id<>p_user_id THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF l.status <> 'completed'
     AND NOT EXISTS (SELECT 1 FROM public.lesson_materials WHERE lesson_id=l.id)
     AND NOT EXISTS (SELECT 1 FROM public.lesson_tasks WHERE lesson_id=l.id)
     AND NOT EXISTS (SELECT 1 FROM public.task_attempts WHERE lesson_id=l.id)
     AND NOT EXISTS (SELECT 1 FROM public.lesson_results WHERE lesson_id=l.id) THEN
    INSERT INTO public.lesson_materials(lesson_id,material_id,order_index,is_required,user_id)
      SELECT l.id, x.id, (x.ord-1)::integer, x.ord=1, p_user_id
      FROM unnest(coalesce(p_material_ids,ARRAY[]::uuid[])) WITH ORDINALITY x(id,ord);
    INSERT INTO public.lesson_tasks(lesson_id,task_id,order_index,points,is_required,user_id)
      SELECT l.id, x.id, (x.ord-1)::integer, 1, true, p_user_id
      FROM unnest(coalesce(p_task_ids,ARRAY[]::uuid[])) WITH ORDINALITY x(id,ord);
  END IF;
  SELECT count(*) INTO material_count FROM public.lesson_materials WHERE lesson_id=l.id;
  SELECT count(*) INTO task_count FROM public.lesson_tasks WHERE lesson_id=l.id;
  RETURN jsonb_build_object('lesson_id',l.id,'materials',material_count,'tasks',task_count);
END $$;
REVOKE ALL ON FUNCTION public.initialize_lesson_assignments(uuid,uuid,uuid[],uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.initialize_lesson_assignments(uuid,uuid,uuid[],uuid[]) TO service_role;
