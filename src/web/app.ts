import type { Job } from "../shared/types";
import { api, uploadFile } from "./upload";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = $<HTMLFormElement>("upload-form");
const fileInput = $<HTMLInputElement>("file");
const fileLabel = $("file-label");
const submit = $<HTMLButtonElement>("submit");
const progress = $("progress");
const bar = $<HTMLProgressElement>("bar");
const progressText = $("progress-text");
const message = $("message");
const tbody = document.querySelector<HTMLTableSectionElement>("#jobs tbody")!;
const empty = $("empty");

function fmtSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

function say(text: string, isError = false) {
  message.textContent = text;
  message.className = isError ? "error" : "";
}

const STATUS_LABEL: Record<string, string> = {
  uploaded: "Sending to Qwen…",
  running: "Transcribing…",
  transcribed: "Ready to review",
  done: "Done",
  failed: "Failed",
};

async function loadJobs() {
  const res = await fetch("/api/jobs");
  if (!res.ok) return;
  const { jobs } = (await res.json()) as { jobs: Job[] };
  tbody.replaceChildren();
  empty.hidden = jobs.length > 0;
  for (const job of jobs) {
    const tr = document.createElement("tr");
    const cells = [
      job.title,
      fmtSize(job.size),
      STATUS_LABEL[job.status] ?? job.status,
      new Date(job.created_at).toLocaleString(),
    ];
    for (const [i, text] of cells.entries()) {
      const td = document.createElement("td");
      td.textContent = text; // textContent: titles are user input
      if (i === 2 && job.error) {
        td.className = "err";
        const why = document.createElement("div");
        why.className = "why";
        why.textContent = job.error;
        td.append(why);
      }
      tr.append(td);
    }
    const td = document.createElement("td");
    if (job.status === "failed") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "link retry";
      retry.textContent = "Retry";
      retry.onclick = async () => {
        retry.disabled = true;
        await fetch(`/api/jobs/${job.id}/retry`, { method: "POST" });
        await loadJobs();
      };
      td.append(retry, " ");
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "link";
    del.textContent = "Delete";
    del.onclick = async () => {
      if (!confirm(`Delete "${job.title}"?`)) return;
      await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
      await loadJobs();
    };
    td.append(del);
    tr.append(td);
    tbody.append(tr);
  }
}

fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  fileLabel.textContent = f ? `${f.name} (${fmtSize(f.size)})` : "Choose an .m4a recording (up to 1 GB, 3+ hours)";
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = fileInput.files?.[0];
  if (!file) return;
  submit.disabled = true;
  progress.hidden = false;
  say("");
  try {
    const { key } = await uploadFile(file, (loaded, total) => {
      bar.value = (loaded / total) * 100;
      progressText.textContent = `${fmtSize(loaded)} / ${fmtSize(total)}`;
    });
    await api("/api/jobs", {
      r2Key: key,
      fileName: file.name,
      title: $<HTMLInputElement>("title").value,
      context: $<HTMLTextAreaElement>("context").value,
      speakerCount: Number($<HTMLInputElement>("speakers").value) || null,
      correction: $<HTMLInputElement>("correction").checked,
    });
    say("Uploaded.");
    form.reset();
    fileLabel.textContent = "Choose an .m4a recording (up to 1 GB, 3+ hours)";
    await loadJobs();
  } catch (err) {
    say(err instanceof Error ? err.message : "Upload failed.", true);
  } finally {
    submit.disabled = false;
    progress.hidden = true;
  }
});

void loadJobs();
setInterval(loadJobs, 15000);
