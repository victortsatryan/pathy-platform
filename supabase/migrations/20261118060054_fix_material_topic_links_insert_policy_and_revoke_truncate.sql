-- Resolve the candidate topic from the row being inserted, not from the
-- legacy materials.topic_id column. Keep the existing admin and provenance
-- requirements, and require the linked topic to belong to the material's
-- subject.
DROP POLICY IF EXISTS "material_topic_links insert admin verified subjects"
  ON public.material_topic_links;

CREATE POLICY "material_topic_links insert admin verified subjects"
ON public.material_topic_links
FOR INSERT
TO authenticated
WITH CHECK (
  public.has_role((SELECT auth.uid()), 'admin'::public.app_role)
  AND material_topic_links.linked_by = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1
    FROM public.materials AS m
    JOIN public.topics AS t
      ON t.id = material_topic_links.topic_id
     AND t.subject_id = m.subject_id
    WHERE m.id = material_topic_links.material_id
      AND m.status = 'published'
      AND m.is_public = true
  )
);

-- authenticated keeps its existing SELECT/INSERT/UPDATE/DELETE grants.
-- Remove only the unnecessary bulk-table operation from the three reviewed
-- tables; service_role/postgres ownership and other grants are untouched.
REVOKE TRUNCATE ON TABLE
  public.material_topic_links,
  public.curriculum_topic_meta,
  public.curriculum_topic_aliases
FROM authenticated;
