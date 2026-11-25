/** Explicit admin topic mapping is the only authoritative link for extracted materials. */
export const LESSON_THEORY_MATERIAL_TYPES = [
  "theory", "video", "article", "reference", "scheme", "textbook_paragraph",
] as const;

export function topicBelongsToSubject(subjectId: string | null, topicSubjectId: string | null) {
  return Boolean(subjectId && topicSubjectId && subjectId === topicSubjectId);
}

/** Short OCR fragments are flagged to an admin, not silently promoted as ready lessons. */
export function needsContentReview(title: string, contentText: string | null) {
  const text = (contentText ?? "").trim();
  return text.length < 100 || !title.trim() || /^[^\p{L}\p{N}]+$/u.test(title.trim());
}

/** A material is source-reviewed only with its unique persisted review row. */
export function hasReviewedSourceMaterial(m: any, sourceSha: string, rows: readonly any[]): boolean {
  const meta = m.extractor_metadata ?? {};
  const review = rows.length === 1 ? rows[0] : null;
  const raw = review?.raw;
  const text = review?.review_choice === "keep_original" ? raw?.content_text :
    review?.review_choice === "accept_corrected" ? review?.reviewed_text : null;
  const status = review?.review_choice === "keep_original" ? "human_approved_original" :
    review?.review_choice === "accept_corrected" ? "human_corrected" : null;
  const hasPrivateBlock = Array.isArray(raw?.source?.source_blocks) && raw.source.source_blocks.some((block: any) =>
    block?.educational_classification_v06?.role === "teacher_private" || block?.source?.private_role === "teacher_private");
  return m.status === "published" && m.is_public === true && meta.role === "student_material" &&
    meta.source_sha256 === sourceSha && !!status && meta.review_status === status && !!review?.reviewed_by && !!review?.reviewed_at &&
    ["published", "existing"].includes(review?.publish_state) && raw?.role === "student_material" && !hasPrivateBlock &&
    raw?.source?.sha256 === sourceSha && raw?.unit_id === review?.unit_id && meta.unit_id === review?.unit_id &&
    typeof text === "string" && !!text.trim() && text.trim() === (m.content_text ?? "").trim();
}


/** Merge legacy primary topic with secondary many-to-many links (UUIDs only). */
export function materialTopicOrFilter(topicId: string, linkedIds: string[]) {
  const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!validUuid.test(topicId) || linkedIds.some((id) => !validUuid.test(id))) {
    throw new Error("Invalid topic/material UUID");
  }
  return linkedIds.length
    ? "topic_id.eq." + topicId + ",id.in.(" + linkedIds.join(",") + ")"
    : "topic_id.eq." + topicId;
}

export async function getLinkedMaterialIds(sb: any, topicId: string): Promise<string[]> {
  const res = await sb.from("material_topic_links")
    .select("material_id").eq("topic_id", topicId).limit(2000);
  if (res.error) throw new Error(res.error.message);
  return Array.from(new Set((res.data ?? []).map((row: { material_id: string }) => row.material_id))) as string[];
}
