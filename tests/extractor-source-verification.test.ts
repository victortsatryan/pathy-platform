import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySourceResponse } from "../src/lib/extractor/source-verification.server";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("private uploaded source verification", () => {
  it("checks the stored bytes, size and source type", async () => {
    await expect(verifySourceResponse(new Response("sample"), { sha256: sha("sample"), size: 6, extension: "txt" })).resolves.toBeUndefined();
  });
  it("rejects spoofed SHA, truncated streams and oversized streams", async () => {
    await expect(verifySourceResponse(new Response("sample"), { sha256: sha("other"), size: 6, extension: "txt" })).rejects.toThrow("SHA-256");
    await expect(verifySourceResponse(new Response("short"), { sha256: sha("short"), size: 6, extension: "txt" })).rejects.toThrow("Размер");
    await expect(verifySourceResponse(new Response("too long"), { sha256: sha("too long"), size: 6, extension: "txt" })).rejects.toThrow("Размер");
  });
  it("fails closed for an incorrect format, empty or failed response", async () => {
    await expect(verifySourceResponse(new Response("sample"), { sha256: sha("sample"), size: 6, extension: "pdf" })).rejects.toThrow("расширению");
    await expect(verifySourceResponse(new Response(""), { sha256: sha(""), size: 0, extension: "txt" })).rejects.toThrow("размер");
    await expect(verifySourceResponse(new Response("failed", { status: 403 }), { sha256: sha("failed"), size: 6, extension: "txt" })).rejects.toThrow("прочитать");
  });
});
