import { Document, HeadingLevel, Paragraph, TextRun } from "docx";
import { formatTimestamp, type NamedTurn } from "../shared/transcript";

export interface DocxMeta {
  title: string;
  /** e.g. "21 Nov 2026" */
  date: string;
  /** e.g. "3 h 5 min"; omitted when unknown */
  duration?: string;
  speakers: string[];
}

const FONT = { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "Microsoft YaHei" };

export function buildDocument(meta: DocxMeta, turns: NamedTurn[]): Document {
  const details = [meta.date, meta.duration, meta.speakers.length ? `Speakers: ${meta.speakers.join(", ")}` : ""]
    .filter(Boolean)
    .join("  ·  ");

  const header = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(meta.title)] }),
    new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: details, color: "666666" })] }),
  ];

  const body =
    turns.length === 0
      ? [new Paragraph({ children: [new TextRun({ text: "No speech was detected.", italics: true })] })]
      : turns.map(
          (t) =>
            new Paragraph({
              spacing: { after: 160 },
              children: [
                new TextRun({ text: `[${formatTimestamp(t.startMs)}] `, color: "888888", size: 18 }),
                new TextRun({ text: `${t.name}: `, bold: true }),
                new TextRun(t.text),
              ],
            }),
        );

  return new Document({
    creator: "Meeting Transcriber",
    title: meta.title,
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{ children: [...header, ...body] }],
  });
}

/** A safe file name for the download. */
export function docxFileName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim().slice(0, 80) || "transcript";
  return `${base}.docx`;
}
