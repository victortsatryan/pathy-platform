import { createHash } from "node:crypto";
import { magicMatches, MAX_SOURCE_BYTES } from "./pipeline";

/** Read the actual private object once, bounded by both configured and recorded size. */
export async function verifySourceResponse(
  response: Response, expected: { sha256: string; size: number; extension: string },
): Promise<void> {
  if (!Number.isSafeInteger(expected.size) || expected.size <= 0 || expected.size > MAX_SOURCE_BYTES)
    throw new Error("Недопустимый размер исходного файла");
  if (!response.ok || !response.body) throw new Error("Не удалось прочитать загруженный файл");
  const reader = response.body.getReader();
  const digest = createHash("sha256");
  const head = new Uint8Array(512);
  let size = 0, headLength = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = part.value;
      size += chunk.length;
      if (size > expected.size || size > MAX_SOURCE_BYTES) throw new Error("Размер файла не совпадает с записью хранилища");
      if (headLength < head.length) {
        const prefix = chunk.subarray(0, head.length - headLength);
        head.set(prefix, headLength);
        headLength += prefix.length;
      }
      digest.update(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (size !== expected.size) throw new Error("Размер файла не совпадает с записью хранилища");
  if (!magicMatches(expected.extension, head.subarray(0, headLength))) throw new Error("Содержимое файла не соответствует расширению");
  if (digest.digest("hex") !== expected.sha256) throw new Error("SHA-256 исходного файла не совпадает");
}
