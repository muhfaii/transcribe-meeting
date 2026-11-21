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
import { buildDocument, docxFileName } from "./docx";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const PREVIEW_TURNS = 40;

let token = 0; // guards against late responses after the user navigated away

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

export async function showJob(id: string) {
  const mine = ++token;
  $("job-title").textContent = "";
  $("job-meta").textContent = "";
  $("job-body").hidden = true;
  setStatus("Loading transcript…");

  try {
    const [job, saved, raw] = await Promise.all([
      getJson<Job>(`/api/jobs/${id}`),
      getJson<{ names: Record<string, string> }>(`/api/jobs/${id}/speakers`),
      getJson<QwenResult>(`/api/jobs/${id}/raw`),
    ]);
    if (mine !== token) return;
    render(job, raw, saved.names);
  } catch (err) {
    if (mine !== token) return;
    setStatus(err instanceof Error ? err.message : "Could not load the transcript.", true);
  }
}

export function leaveJob() {
  token++;
}

function render(job: Job, raw: QwenResult, savedNames: Record<string, string>) {
  const turns = normalizeResult(raw);
  const speakers = speakersIn(turns);
  const custom: Record<string, string> = { ...savedNames };
  const durationMs = raw.properties?.original_duration_in_milliseconds ?? turns[turns.length - 1]?.endMs ?? 0;

  $("job-title").textContent = job.title;
  $("job-meta").textContent = [
    durationMs ? formatDuration(durationMs) : "",
    `${speakers.length} speaker${speakers.length === 1 ? "" : "s"}`,
    new Date(job.created_at).toLocaleDateString(),
  ]
    .filter(Boolean)
    .join(" · ");
  setStatus(turns.length === 0 ? "No speech was detected in this recording." : "");
  $("job-body").hidden = false;

  const list = $("speaker-list");
  list.replaceChildren();
  const saveNote = $("save-note");
  saveNote.textContent = "";

  const names = () => resolveNames(speakers, custom);

  const draw = () => renderPreview(turns, names());

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

  for (const sp of speakers) list.append(speakerRow(sp, names()[sp.key], custom[sp.key] ?? "", (value) => {
    custom[sp.key] = value;
    saveNote.textContent = "";
    draw();
    save();
  }));
  draw();

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
        applyNames(turns, resolved),
      );
      saveBlob(await Packer.toBlob(doc), docxFileName(job.title));
    } catch {
      setStatus("Could not build the DOCX.", true);
    } finally {
      download.disabled = false;
    }
  };
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
  const shown = applyNames(turns, names).slice(0, PREVIEW_TURNS);
  for (const t of shown) {
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
  const total = applyNames(turns, names).length;
  $("preview-note").textContent = total > shown.length ? `Showing the first ${shown.length} of ${total} paragraphs. The DOCX has all of them.` : "";
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
