/**
 * Shared answer normalisation for auto-checked tasks.
 * trim + lowercase + ё→е + strip spaces and light punctuation,
 * so «1, 3» / «13» / «1 3» all match the key «13».
 */
export function normalizeAnswer(value: unknown): string {
  if (value == null) return "";
  const s = typeof value === "string" ? value : String(value);
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\s.,;:]+/g, "")
    .trim();
}

/** true / false, or null when the answer is empty or there is no key. */
export function isAnswerCorrect(
  correct: unknown,
  studentAnswer: string | string[] | null,
): boolean | null {
  if (
    studentAnswer == null ||
    (typeof studentAnswer === "string" && studentAnswer.trim() === "") ||
    (Array.isArray(studentAnswer) && studentAnswer.length === 0)
  ) return null;
  if (correct == null) return null;
  if (Array.isArray(studentAnswer)) {
    const given = studentAnswer.map(normalizeAnswer).sort();
    const expected = (Array.isArray(correct) ? correct : [correct]).map(normalizeAnswer).sort();
    return given.length === expected.length && given.every((answer, index) => answer === expected[index]);
  }
  const given = normalizeAnswer(studentAnswer);
  if (Array.isArray(correct)) return correct.map(normalizeAnswer).includes(given);
  if (typeof correct === "object") return normalizeAnswer(JSON.stringify(correct)) === given;
  return normalizeAnswer(correct) === given;
}
