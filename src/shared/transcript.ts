// Pure transcript logic (no DOM, no Worker APIs): Qwen result -> speaker turns -> display names.
import type { QwenResult } from "./qwen-config";

export interface Turn {
  startMs: number;
  endMs: number;
  /** Qwen speaker_id as a string ("0", "1", …) or "?" when diarization gave none. */
  speaker: string;
  text: string;
}

export interface SpeakerInfo {
  key: string;
  turns: number;
  talkMs: number;
  /** First line this speaker said, to help the user recognise them. */
  sample: string;
}

// A new paragraph starts when the speaker changes, after a long pause, or when it gets long.
export const MAX_GAP_MS = 3000;
export const MAX_TURN_MS = 90_000;
export const MAX_TURN_CHARS = 800;

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿＀-￯]/;

/** Joins two sentences: no space next to Chinese/Japanese text, a space otherwise. */
export function joinText(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const noSpace = CJK.test(a[a.length - 1]) || CJK.test(b[0]);
  return noSpace ? a + b : `${a} ${b}`;
}

export function normalizeResult(result: QwenResult): Turn[] {
  const sentences = (result.transcripts ?? [])
    .flatMap((t) => t.sentences ?? [])
    .filter((s) => typeof s.text === "string" && s.text.trim() !== "")
    .map((s) => ({
      startMs: s.begin_time,
      endMs: s.end_time,
      speaker: s.speaker_id === undefined || s.speaker_id === null ? "?" : String(s.speaker_id),
      text: s.text.trim(),
    }))
    .sort((a, b) => a.startMs - b.startMs);

  const turns: Turn[] = [];
  for (const s of sentences) {
    const last = turns[turns.length - 1];
    const sameParagraph =
      last &&
      last.speaker === s.speaker &&
      s.startMs - last.endMs <= MAX_GAP_MS &&
      s.endMs - last.startMs <= MAX_TURN_MS &&
      last.text.length + s.text.length <= MAX_TURN_CHARS;
    if (sameParagraph) {
      last.text = joinText(last.text, s.text);
      last.endMs = Math.max(last.endMs, s.endMs);
    } else {
      turns.push({ ...s });
    }
  }
  return turns;
}

/** Speakers in order of first appearance. */
export function speakersIn(turns: Turn[]): SpeakerInfo[] {
  const map = new Map<string, SpeakerInfo>();
  for (const t of turns) {
    let info = map.get(t.speaker);
    if (!info) {
      info = { key: t.speaker, turns: 0, talkMs: 0, sample: t.text.slice(0, 80) };
      map.set(t.speaker, info);
    }
    info.turns += 1;
    info.talkMs += Math.max(0, t.endMs - t.startMs);
  }
  return [...map.values()];
}

/** "Speaker 1", "Speaker 2", … by order of first appearance; "Unknown speaker" for "?". */
export function defaultNames(speakers: SpeakerInfo[]): Record<string, string> {
  const names: Record<string, string> = {};
  let n = 0;
  for (const s of speakers) names[s.key] = s.key === "?" ? "Unknown speaker" : `Speaker ${++n}`;
  return names;
}

/** Display name for each speaker key: the user's name when set, else the default. */
export function resolveNames(
  speakers: SpeakerInfo[],
  custom: Record<string, string>,
): Record<string, string> {
  const names = defaultNames(speakers);
  for (const s of speakers) {
    const c = (custom[s.key] ?? "").trim();
    if (c) names[s.key] = c;
  }
  return names;
}

export interface NamedTurn {
  startMs: number;
  endMs: number;
  name: string;
  text: string;
}

/**
 * Applies display names. Two speakers given the same name are merged, and consecutive turns by
 * the same name are joined again (the merge-speakers fallback when diarization split one person).
 */
export function applyNames(turns: Turn[], names: Record<string, string>): NamedTurn[] {
  const out: NamedTurn[] = [];
  for (const t of turns) {
    const name = names[t.speaker] ?? t.speaker;
    const last = out[out.length - 1];
    if (
      last &&
      last.name === name &&
      t.startMs - last.endMs <= MAX_GAP_MS &&
      t.endMs - last.startMs <= MAX_TURN_MS &&
      last.text.length + t.text.length <= MAX_TURN_CHARS
    ) {
      last.text = joinText(last.text, t.text);
      last.endMs = Math.max(last.endMs, t.endMs);
    } else {
      out.push({ startMs: t.startMs, endMs: t.endMs, name, text: t.text });
    }
  }
  return out;
}

/** 83_000 -> "00:01:23" */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return "under 1 min";
  const total = Math.round(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}
