import { describe, expect, it } from "vitest";
import {
  applyNames,
  defaultNames,
  formatDuration,
  formatTimestamp,
  joinText,
  normalizeResult,
  resolveNames,
  speakersIn,
} from "../src/shared/transcript";
import type { QwenResult } from "../src/shared/qwen-config";

const s = (begin: number, end: number, text: string, speaker?: number) => ({
  begin_time: begin,
  end_time: end,
  text,
  ...(speaker === undefined ? {} : { speaker_id: speaker }),
});
const result = (...sentences: ReturnType<typeof s>[]): QwenResult => ({
  transcripts: [{ channel_id: 0, text: "", sentences }],
});

describe("joinText", () => {
  it("adds a space between Latin text and none next to CJK", () => {
    expect(joinText("Hello.", "World.")).toBe("Hello. World.");
    expect(joinText("好的，", "我们开始。")).toBe("好的，我们开始。");
    expect(joinText("Okay", "好的")).toBe("Okay好的");
    expect(joinText("", "x")).toBe("x");
  });
});

describe("normalizeResult", () => {
  it("merges consecutive sentences by the same speaker", () => {
    const turns = normalizeResult(result(s(0, 1000, "Halo.", 0), s(1200, 2000, "Apa kabar?", 0), s(2500, 4000, "Baik.", 1)));
    expect(turns).toEqual([
      { startMs: 0, endMs: 2000, speaker: "0", text: "Halo. Apa kabar?" },
      { startMs: 2500, endMs: 4000, speaker: "1", text: "Baik." },
    ]);
  });
  it("starts a new paragraph after a long pause or when too long", () => {
    expect(normalizeResult(result(s(0, 1000, "a", 0), s(9000, 10000, "b", 0)))).toHaveLength(2);
    const long = Array.from({ length: 40 }, (_, i) => s(i * 3000, i * 3000 + 2900, "word ".repeat(10), 0));
    expect(normalizeResult(result(...long)).length).toBeGreaterThan(1);
  });
  it("sorts by time, skips empty text and handles a missing speaker", () => {
    const turns = normalizeResult(result(s(5000, 6000, "second", 1), s(0, 1000, "first"), s(2000, 3000, "  ", 0)));
    expect(turns.map((t) => [t.speaker, t.text])).toEqual([["?", "first"], ["1", "second"]]);
  });
  it("copes with an empty result", () => {
    expect(normalizeResult({ transcripts: [] })).toEqual([]);
    expect(normalizeResult({} as QwenResult)).toEqual([]);
  });
});

describe("speakers and names", () => {
  const turns = normalizeResult(result(s(0, 2000, "Hi", 1), s(3000, 9000, "Hello there", 0), s(10000, 12000, "Bye", 1)));
  it("lists speakers by first appearance with talk time", () => {
    const sp = speakersIn(turns);
    expect(sp.map((x) => x.key)).toEqual(["1", "0"]);
    expect(sp[0]).toMatchObject({ turns: 2, talkMs: 4000, sample: "Hi" });
  });
  it("numbers default names by first appearance", () => {
    expect(defaultNames(speakersIn(turns))).toEqual({ "1": "Speaker 1", "0": "Speaker 2" });
    expect(defaultNames(speakersIn(normalizeResult(result(s(0, 1, "x")))))).toEqual({ "?": "Unknown speaker" });
  });
  it("uses custom names and ignores blanks", () => {
    expect(resolveNames(speakersIn(turns), { "1": " Budi ", "0": "  " })).toEqual({ "1": "Budi", "0": "Speaker 2" });
  });
  it("merges speakers that share a name", () => {
    const named = applyNames(turns, { "1": "Budi", "0": "Budi" });
    expect(named).toHaveLength(1);
    expect(named[0]).toMatchObject({ name: "Budi", text: "Hi Hello there Bye" });
  });
  it("does not merge across a long pause", () => {
    const t = normalizeResult(result(s(0, 1000, "a", 0), s(20000, 21000, "b", 1)));
    expect(applyNames(t, { "0": "Budi", "1": "Budi" })).toHaveLength(2);
  });
});

describe("formatting", () => {
  it("formats timestamps and durations", () => {
    expect(formatTimestamp(0)).toBe("00:00:00");
    expect(formatTimestamp(83_000)).toBe("00:01:23");
    expect(formatTimestamp(3 * 3600_000 + 5 * 60_000 + 7_000)).toBe("03:05:07");
    expect(formatDuration(12_000)).toBe("under 1 min");
    expect(formatDuration(45 * 60_000)).toBe("45 min");
    expect(formatDuration(185 * 60_000)).toBe("3 h 5 min");
  });
});

describe("long recordings", () => {
  it("processes a 3-hour, 3-speaker transcript and builds the DOCX quickly", async () => {
    const sentences = Array.from({ length: 4000 }, (_, i) =>
      s(i * 2700, i * 2700 + 2500, `Kalimat nomor ${i} dalam rapat yang panjang.`, Math.floor(i / 7) % 3),
    );
    const t0 = performance.now();
    const turns = normalizeResult(result(...sentences));
    const names = resolveNames(speakersIn(turns), { "0": "Budi" });
    const named = applyNames(turns, names);
    const { buildDocument } = await import("../src/web/docx");
    const { Packer } = await import("docx");
    const buf = await Packer.toBuffer(buildDocument({ title: "Long", date: "x", speakers: [] }, named));
    expect(named.length).toBeGreaterThan(500);
    expect(buf.byteLength).toBeGreaterThan(10_000);
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});
