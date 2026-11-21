import { describe, expect, it } from "vitest";
import {
  ASR_CONTEXT_MAX_CHARS,
  buildSubmitBody,
  buildVocabulary,
  parseTaskResponse,
  validateHotword,
} from "../src/shared/qwen-config";

describe("validateHotword", () => {
  it("applies the ASCII and non-ASCII length rules", () => {
    expect(validateHotword("Kelyra")).toBeNull();
    expect(validateHotword("Human immunodeficiency virus type 1")).toBeNull(); // 5 words
    expect(validateHotword("a b c d e f g h")).not.toBeNull(); // 8 words
    expect(validateHotword("厄洛替尼盐酸盐")).toBeNull();
    expect(validateHotword("一二三四五六七八九十一二三四五六")).not.toBeNull(); // 16 chars
    expect(validateHotword("   ")).not.toBeNull();
  });
});

describe("buildVocabulary", () => {
  it("defaults the weight, drops invalid and duplicate terms", () => {
    expect(
      buildVocabulary([
        { term: "Budi" },
        { term: "Siti", weight: 5 },
        { term: "Budi", weight: 2 },
        { term: "x", weight: 99 },
        { term: "a b c d e f g h" },
      ]),
    ).toEqual({ Budi: 4, Siti: 5, x: 4 });
  });
});

describe("buildSubmitBody", () => {
  it("builds the documented request", () => {
    const body = buildSubmitBody("m", { fileUrl: "https://a/b.m4a" });
    expect(body).toEqual({
      model: "m",
      input: { file_urls: ["https://a/b.m4a"] },
      parameters: { channel_id: [0], diarization_enabled: true, language_hints: ["id", "en", "zh"] },
    });
  });
  it("adds context (truncated) and vocabulary when present", () => {
    const body = buildSubmitBody("m", {
      fileUrl: "u",
      context: "x".repeat(1000),
      hotwords: [{ term: "Budi" }],
    });
    const msg = (body.input as any).context[0];
    expect(msg.role).toBe("user");
    expect(msg.content[0].type).toBe("input_text");
    expect(msg.content[0].text.length).toBe(ASR_CONTEXT_MAX_CHARS);
    expect((body.parameters as any).vocabulary).toEqual({ Budi: 4 });
  });
  it("omits empty context and vocabulary", () => {
    const body = buildSubmitBody("m", { fileUrl: "u", context: "  ", hotwords: [] });
    expect((body.input as any).context).toBeUndefined();
    expect((body.parameters as any).vocabulary).toBeUndefined();
  });
});

describe("parseTaskResponse", () => {
  it("treats PENDING/RUNNING/unknown as pending", () => {
    for (const s of ["PENDING", "RUNNING", "WEIRD", undefined]) {
      expect(parseTaskResponse({ output: { task_status: s } }).state).toBe("pending");
    }
  });
  it("returns the result url and usage on success", () => {
    const r = parseTaskResponse({
      usage: { duration: 10 },
      output: { task_status: "SUCCEEDED", results: [{ subtask_status: "SUCCEEDED", transcription_url: "https://r" }] },
    });
    expect(r).toEqual({ state: "succeeded", transcriptionUrl: "https://r", usage: { duration: 10 } });
  });
  it("fails when the subtask failed or the task failed", () => {
    expect(
      parseTaskResponse({ output: { task_status: "SUCCEEDED", results: [{ subtask_status: "FAILED", message: "bad audio" }] } }),
    ).toMatchObject({ state: "failed" });
    const f = parseTaskResponse({ output: { task_status: "FAILED", message: "boom" } });
    expect(f.state).toBe("failed");
    expect((f as { message: string }).message).toContain("boom");
  });
});
