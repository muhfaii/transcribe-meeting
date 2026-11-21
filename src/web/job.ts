import { Packer } from "docx";
import type { Job } from "../shared/types";
import type { QwenResult } from "../shared/qwen-config";
import {
  applyNames,
  formatDuration,
  formatTimestamp,
  normalizeResult,
  resolveNames,
  speakersIn,
  type SpeakerInfo,
  type Turn,
} from "../shared/transcript";
import { countChanged, type SavedSegments } from "../shared/correction";
import { buildDocument, docxFileName } from "./docx";
import { runCorrection } from "./correct";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const PREVIEW_TURNS = 40;

let token = 0; // guards against late responses after the user navigated away
let activeAi: AbortController | null = null;

function setStatus(text: string, isError = false) {
  const el = $("job-status");
  el.textContent = text;
  el.className = isError ? "error" : "";
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `Request failed (${res.status})`);
  return (await res.json()) as T;
}

async function getOptionalJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url);
  return res.ok ? ((await res.json()) as T) : null;
}

export async function showJob(id: string) {
  const mine = ++token;
  activeAi?.abort();
  $("job-title").textContent = "";
  $("job-meta").textContent = "";
  $("job-body").hidden = true;
  setStatus("Loading transcript…");

  try {
    const [job, saved, raw, result] = await Promise.all([
      getJson<Job>(`/api/jobs/${id}`),
      getJson<{ names: Record<string, string> }>(`/api/jobs/${id}/speakers`),
      getJson<QwenResult>(`/api/jobs/${id}/raw`),
      getOptionalJson<SavedSegments>(`/api/jobs/${id}/result`),
    ]);
    if (mine !== token) return;
    render(job, raw, saved.names, result && Array.isArray(result.turns) ? result : null, mine);
  } catch (err) {
    if (mine !== token) return;
    setStatus(err instanceof Error ? err.message : "Could not load the transcript.", true);
  }
}

export function leaveJob() {
  token++;
  activeAi?.abort();
}

function render(job: Job, raw: QwenResult, savedNames: Record<string, string>, saved: SavedSegments | null, mine: number) {
  const original = normalizeResult(raw);
  const speakers = speakersIn(original);
  const custom: Record<string, string> = { ...savedNames };
  const durationMs = raw.properties?.original_duration_in_milliseconds ?? original[original.length - 1]?.endMs ?? 0;

  let corrected: Turn[] | null = saved?.turns ?? null;
  let useOriginal = false;
  const current = () => (corrected && !useOriginal ? corrected : original);
  const names = () => resolveNames(speakers, custom);

  $("job-title").textContent = job.title;
  $("job-meta").textContent = [
    durationMs ? formatDuration(durationMs) : "",
    `${speakers.length} speaker${speakers.length === 1 ? "" : "s"}`,
    new Date(job.created_at).toLocaleDateString(),
  ]
    .filter(Boolean)
    .join(" · ");
  setStatus(original.length === 0 ? "No speech was detected in this recording." : "");
  $("job-body").hidden = false;

  const draw = () => renderPreview(current(), names());

  // ---- speakers ----
  const list = $("speaker-list");
  list.replaceChildren();
  const saveNote = $("save-note");
  saveNote.textContent = "";
  let timer: number | undefined;
  const save = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const res = await fetch(`/api/jobs/${job.id}/speakers`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ names: custom }),
      });
      saveNote.textContent = res.ok ? "Names saved." : "Could not save names.";
    }, 400);
  };
  for (const sp of speakers) {
    list.append(
      speakerRow(sp, names()[sp.key], custom[sp.key] ?? "", (value) => {
        custom[sp.key] = value;
        saveNote.textContent = "";
        draw();
        save();
      }),
    );
  }

  // ---- AI correction ----
  const aiStatus = $("ai-status");
  const aiBar = $<HTMLProgressElement>("ai-bar");
  const aiRun = $<HTMLButtonElement>("ai-run");
  const aiCancel = $<HTMLButtonElement>("ai-cancel");
  const originalWrap = $("original-wrap");
  const useOriginalBox = $<HTMLInputElement>("use-original");
  useOriginalBox.checked = false;

  const refreshAi = () => {
    aiRun.textContent = corrected ? "Re-run AI correction" : "Improve with AI";
    originalWrap.hidden = !corrected;
    aiRun.disabled = original.length === 0;
    if (corrected) aiStatus.textContent = `AI-corrected: ${countChanged(original, corrected)} of ${original.length} paragraphs changed.`;
  };
  useOriginalBox.onchange = () => {
    useOriginal = useOriginalBox.checked;
    draw();
  };

  const runAi = async () => {
    const ctl = new AbortController();
    activeAi = ctl;
    aiRun.disabled = true;
    aiCancel.hidden = false;
    aiBar.hidden = false;
    aiStatus.textContent = "Improving with AI… (the original text stays available)";
    try {
      const result = await runCorrection(job.id, original, (done, total) => {
        if (mine !== token) return;
        aiBar.max = total;
        aiBar.value = done;
        aiStatus.textContent = `Improving with AI… ${done}/${total}`;
      }, ctl.signal);
      if (mine !== token) return;
      corrected = result;
      useOriginal = false;
      useOriginalBox.checked = false;
      const res = await fetch(`/api/jobs/${job.id}/result`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, turns: result } satisfies SavedSegments),
      });
      refreshAi();
      if (!res.ok) aiStatus.textContent += " (could not be saved — run it again to retry)";
      draw();
    } catch (e) {
      if (mine !== token) return;
      aiStatus.textContent =
        (e as Error).name === "AbortError"
          ? "Cancelled. Showing the previous text."
          : `AI correction failed: ${e instanceof Error ? e.message : "unknown error"}. Showing the previous text.`;
    } finally {
      if (mine === token) {
        aiBar.hidden = true;
        aiCancel.hidden = true;
        aiRun.disabled = original.length === 0;
        if (activeAi === ctl) activeAi = null;
      }
    }
  };
  aiRun.onclick = () => void runAi();
  aiCancel.onclick = () => activeAi?.abort();
  aiBar.hidden = true;
  aiCancel.hidden = true;
  aiStatus.textContent = corrected ? "" : "Not corrected yet.";
  refreshAi();

  draw();

  // ---- DOCX ----
  const download = $<HTMLButtonElement>("download");
  download.onclick = async () => {
    download.disabled = true;
    try {
      const resolved = names();
      const doc = buildDocument(
        {
          title: job.title,
          date: new Date(job.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }),
          duration: durationMs ? formatDuration(durationMs) : undefined,
          speakers: [...new Set(speakers.map((s) => resolved[s.key]))],
        },
        applyNames(current(), resolved),
      );
      saveBlob(await Packer.toBlob(doc), docxFileName(job.title));
    } catch {
      setStatus("Could not build the DOCX.", true);
    } finally {
      download.disabled = false;
    }
  };

  // First visit to a recording that asked for correction: run it automatically.
  if (!saved && job.use_correction === 1 && original.length > 0) void runAi();
}

function speakerRow(sp: SpeakerInfo, current: string, custom: string, onChange: (v: string) => void): HTMLElement {
  const row = document.createElement("label");
  row.className = "speaker";
  const head = document.createElement("span");
  head.textContent = `${current} — ${formatDuration(sp.talkMs)} spoken`;
  const sample = document.createElement("small");
  sample.textContent = `“${sp.sample}”`;
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 60;
  input.value = custom;
  input.placeholder = current;
  input.addEventListener("input", () => onChange(input.value));
  row.append(head, sample, input);
  return row;
}

function renderPreview(turns: Turn[], names: Record<string, string>) {
  const box = $("preview");
  box.replaceChildren();
  const all = applyNames(turns, names);
  for (const t of all.slice(0, PREVIEW_TURNS)) {
    const p = document.createElement("p");
    p.className = "turn";
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = `[${formatTimestamp(t.startMs)}] `;
    const who = document.createElement("strong");
    who.textContent = `${t.name}: `;
    p.append(time, who, document.createTextNode(t.text)); // text nodes: transcript is untrusted
    box.append(p);
  }
  $("preview-note").textContent =
    all.length > PREVIEW_TURNS ? `Showing the first ${PREVIEW_TURNS} of ${all.length} paragraphs. The DOCX has all of them.` : "";
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
