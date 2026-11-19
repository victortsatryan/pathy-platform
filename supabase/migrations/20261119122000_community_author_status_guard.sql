-- Authors can submit their own work, but moderation/publication belongs to
-- the existing administrator policy. Existing rows are not modified.
DROP POLICY IF EXISTS "Authors can insert own candidates" ON public.content_candidates;
CREATE POLICY "Authors can insert own candidates" ON public.content_candidates
  FOR INSERT TO authenticated
  WITH CHECK (author_id = auth.uid() AND status IN ('draft','submitted'));
DROP POLICY IF EXISTS "Authors can update own draft/submitted candidates" ON public.content_candidates;
CREATE POLICY "Authors can update own draft/submitted candidates" ON public.content_candidates
  FOR UPDATE TO authenticated
  USING (author_id = auth.uid() AND status IN ('draft','submitted'))
  WITH CHECK (author_id = auth.uid() AND status IN ('draft','submitted'));

-- Author edits cannot forge moderator attribution or publication metadata.
CREATE OR REPLACE FUNCTION public.guard_candidate_moderation_fields()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF current_user='authenticated' AND NOT public.has_role(auth.uid(),'admin'::public.app_role) THEN
    IF TG_OP='INSERT' AND (NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.published_at IS NOT NULL OR NEW.admin_notes IS NOT NULL OR NEW.learning_objective_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Moderation fields are administrator-only';
    ELSIF TG_OP='UPDATE' AND (NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.admin_notes IS DISTINCT FROM OLD.admin_notes OR NEW.learning_objective_id IS DISTINCT FROM OLD.learning_objective_id) THEN
      RAISE EXCEPTION 'Moderation fields are administrator-only';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_candidate_moderation_fields_before_write
  BEFORE INSERT OR UPDATE ON public.content_candidates FOR EACH ROW
  EXECUTE FUNCTION public.guard_candidate_moderation_fields();
