import { MAX_HOTWORDS, validateHotword } from "../shared/qwen-config";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Term {
  id: number;
  term: string;
  note: string;
}

function say(text: string, isError = false) {
  const el = $("glossary-message");
  el.textContent = text;
  el.className = isError ? "error" : "";
}

export async function showGlossary() {
  say("");
  const res = await fetch("/api/glossary");
  if (!res.ok) return say("Could not load the glossary.", true);
  const { terms } = (await res.json()) as { terms: Term[] };
  $("glossary-count").textContent = `${terms.length} / ${MAX_HOTWORDS} terms`;
  $("glossary-empty").hidden = terms.length > 0;
  const body = document.querySelector<HTMLTableSectionElement>("#glossary-table tbody")!;
  body.replaceChildren();
  for (const t of terms) {
    const tr = document.createElement("tr");
    const term = document.createElement("td");
    term.textContent = t.term; // textContent: user input
    const note = document.createElement("td");
    note.textContent = t.note;
    const act = document.createElement("td");
    const del = document.createElement("button");
    del.type = "button";
    del.className = "link";
    del.textContent = "Delete";
    del.onclick = async () => {
      await fetch(`/api/glossary/${t.id}`, { method: "DELETE" });
      await showGlossary();
    };
    act.append(del);
    tr.append(term, note, act);
    body.append(tr);
  }
}

export function initGlossary() {
  const form = $<HTMLFormElement>("glossary-form");
  const term = $<HTMLInputElement>("glossary-term");
  const note = $<HTMLInputElement>("glossary-note");

  // Same rules as the speech model, checked as you type.
  term.addEventListener("input", () => {
    const text = term.value.trim();
    say(text ? validateHotword(text) ?? "" : "", Boolean(text && validateHotword(text)));
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const problem = validateHotword(term.value);
    if (problem) return say(problem, true);
    const res = await fetch("/api/glossary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ term: term.value, note: note.value }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return say(data.error || "Could not add the term.", true);
    }
    form.reset();
    await showGlossary();
    say("Added.");
  });
}
