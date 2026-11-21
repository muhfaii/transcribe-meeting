import { describe, expect, it } from "vitest";
import {
  CHUNK_MAX_ITEMS,
  ITEMS_MARKER,
  acceptCorrection,
  applyCorrections,
  buildCorrectionMessages,
  chunkTurns,
  countChanged,
  parseCorrectionResponse,
} from "../src/shared/correction";
import type { Turn } from "../src/shared/transcript";

const turn = (text: string, n = 0): Turn => ({ startMs: n * 1000, endMs: n * 1000 + 900, speaker: "0", text });

describe("chunkTurns", () => {
  it("keeps original indexes and splits by count and size", () => {
    const turns = Array.from({ length: CHUNK_MAX_ITEMS * 2 + 5 }, (_, n) => turn("x", n));
    const chunks = chunkTurns(turns);
    expect(chunks.map((c) => c.length)).toEqual([CHUNK_MAX_ITEMS, CHUNK_MAX_ITEMS, 5]);
    expect(chunks[1][0].i).toBe(CHUNK_MAX_ITEMS);
    const big = chunkTurns([turn("a".repeat(4000)), turn("b".repeat(4000)), turn("c")]);
    expect(big.map((c) => c.map((x) => x.i))).toEqual([[0], [1, 2]]);
    expect(chunkTurns([])).toEqual([]);
  });
});

describe("buildCorrectionMessages", () => {
  it("includes context, terms and the items as JSON", () => {
    const items = [{ i: 3, text: "Halo Kellira" }];
    const [system, user] = buildCorrectionMessages({
      context: "Weekly sync with Budi",
      terms: [{ term: "Kelyra", note: "colleague" }, { term: "Qwen" }],
      items,
    });
    expect(system.role).toBe("system");
    expect(system.content).toMatch(/never translate/);
    expect(user.content).toContain("Weekly sync with Budi");
    expect(user.content).toContain("- Kelyra (colleague)");
    expect(user.content).toContain("- Qwen");
    expect(JSON.parse(user.content.split(ITEMS_MARKER)[1])).toEqual(items);
  });
  it("marks empty context and terms", () => {
    const [, user] = buildCorrectionMessages({ context: "  ", terms: [], items: [] });
    expect(user.content).toContain("Meeting context:\n(none)");
    expect(user.content).toContain("Reference terms (correct spellings):\n(none)");
  });
});

describe("acceptCorrection", () => {
  it("accepts small fixes and rejects rewrites and translations", () => {
    expect(acceptCorrection("Please send it to Kellira", "Please send it to Kelyra")).toBe(true);
    expect(acceptCorrection("Kirim ke Kellira", "")).toBe(false);
    expect(acceptCorrection("Kirim laporan itu ke Kellira sebelum hari Jumat", "Send")).toBe(false);
    expect(acceptCorrection("Hello", "Hello ".repeat(10))).toBe(false);
    expect(acceptCorrection("好的，我们现在开始吧。", "Okay, let's start now.")).toBe(false);
    expect(acceptCorrection("好的，我们开始。", "好的，我们开始！")).toBe(true);
  });
});

describe("parseCorrectionResponse", () => {
  const items = [
    { i: 0, text: "Halo Kellira" },
    { i: 1, text: "Siap" },
    { i: 2, text: "好的，我们开始。" },
  ];
  it("keeps only accepted, changed corrections for known indexes", () => {
    const reply = JSON.stringify({
      items: [
        { i: 0, text: "Halo Kelyra" },
        { i: 1, text: "Siap" }, // unchanged
        { i: 2, text: "Okay, we begin." }, // translation -> rejected
        { i: 9, text: "unknown index" },
        { i: 0, text: "duplicate" },
        { i: "x", text: "bad index type" },
      ],
    });
    expect(parseCorrectionResponse(reply, items)).toEqual([{ i: 0, text: "Halo Kelyra" }]);
  });
  it("copes with code fences, prose and garbage", () => {
    const fenced = '```json\n{"items":[{"i":0,"text":"Halo Kelyra"}]}\n```';
    expect(parseCorrectionResponse(fenced, items)).toHaveLength(1);
    expect(parseCorrectionResponse("Sure! " + fenced + " Done.", items)).toHaveLength(1);
    for (const bad of ["", "no json", "{", '{"items":"x"}', '{"items":[1,null]}']) {
      expect(parseCorrectionResponse(bad, items)).toEqual([]);
    }
  });
});

describe("applyCorrections / countChanged", () => {
  it("replaces text by index and counts changes", () => {
    const turns = [turn("a", 0), turn("b", 1)];
    const fixed = applyCorrections(turns, [{ i: 1, text: "B" }]);
    expect(fixed.map((t) => t.text)).toEqual(["a", "B"]);
    expect(turns[1].text).toBe("b"); // not mutated
    expect(countChanged(turns, fixed)).toBe(1);
    expect(countChanged(turns, [])).toBe(0);
  });
});
