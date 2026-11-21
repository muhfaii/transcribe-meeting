import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { Packer } from "docx";
import { buildDocument, docxFileName } from "../src/web/docx";

async function documentXml(turns: Parameters<typeof buildDocument>[1]) {
  const doc = buildDocument(
    { title: "Weekly <sync> & more", date: "21 Nov 2026", duration: "3 h 5 min", speakers: ["Budi", "Siti"] },
    turns,
  );
  const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));
  return zip.file("word/document.xml")!.async("string");
}

describe("buildDocument", () => {
  it("writes title, details and one paragraph per turn with timestamp and name", async () => {
    const xml = await documentXml([
      { startMs: 0, endMs: 3000, name: "Budi", text: "Selamat pagi." },
      { startMs: 3_725_000, endMs: 3_730_000, name: "Siti", text: "好的，我们开始。" },
    ]);
    expect(xml).toContain("Weekly &lt;sync&gt; &amp; more");
    expect(xml).toContain("Speakers: Budi, Siti");
    expect(xml).toContain("[00:00:00] ");
    expect(xml).toContain("[01:02:05] ");
    expect(xml).toContain("Budi: ");
    expect(xml).toContain("Selamat pagi.");
    expect(xml).toContain("好的，我们开始。");
  });
  it("says so when there is no speech", async () => {
    expect(await documentXml([])).toContain("No speech was detected.");
  });
});

describe("docxFileName", () => {
  it("removes unsafe characters and falls back", () => {
    expect(docxFileName('a/b:c*"d"?.m4a')).toBe("abcd.m4a.docx");
    expect(docxFileName("   ")).toBe("transcript.docx");
    expect(docxFileName("会议 记录")).toBe("会议 记录.docx");
  });
});
