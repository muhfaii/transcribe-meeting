// Everything Qwen-specific lives here: endpoint, request shape, limits, result shape.
// Source: QwenCloud docs (non-real-time ASR, "Improve recognition accuracy", pricing).
// Items marked UNVERIFIED are guesses to confirm with scripts/qwen-probe.sh.

export const QWEN_DEFAULT_BASE_URL = "https://ap-southeast-1.maas.qwencloudapi.com";
export const QWEN_DEFAULT_MODEL = "qwen-audio-3.1-asr-flash-filetrans";
// Chat model for the optional AI correction pass.
// UNVERIFIED: neither the endpoint path nor the model name came from the docs you pasted.
// Override with the QWEN_CHAT_URL / QWEN_CHAT_MODEL vars; check with scripts/qwen-chat-probe.sh.
export const QWEN_DEFAULT_CHAT_MODEL = "qwen-plus";
export const QWEN_CHAT_PATH = "/compatible-mode/v1/chat/completions";
export const SUBMIT_PATH = "/api/v1/services/audio/asr/transcription";
export const taskPath = (taskId: string) => `/api/v1/tasks/${encodeURIComponent(taskId)}`;

/** The docs mark diarization as mono-only, so only channel 0 is sent. */
export const CHANNEL_IDS = [0];
/** UNVERIFIED: hint list for our three languages; confirm mixed-language behaviour with the probe. */
export const LANGUAGE_HINTS = ["id", "en", "zh"];

// Context enhancement: latest 5 turns, <= 400 characters of text per turn (extra is silently cut).
export const ASR_CONTEXT_MAX_CHARS = 400;
// Instant hotwords (parameters.vocabulary): up to 2000 terms per request, weight 1-5 (start at 4).
export const MAX_HOTWORDS = 2000;
export const DEFAULT_HOTWORD_WEIGHT = 4;

export interface SubmitOptions {
  fileUrl: string;
  /** Free-text meeting context; only the first ASR_CONTEXT_MAX_CHARS characters reach the ASR model. */
  context?: string;
  hotwords?: { term: string; weight?: number }[];
}

/** Returns an error message when a hotword breaks the model's text rules, else null. */
export function validateHotword(text: string): string | null {
  const t = text.trim();
  if (!t) return "Term is empty.";
  // eslint-disable-next-line no-control-regex
  const nonAscii = /[^\x00-\x7F]/.test(t);
  if (nonAscii) {
    return [...t].length <= 15 ? null : "Terms with non-ASCII characters (e.g. Chinese) can be at most 15 characters.";
  }
  return t.split(/\s+/).length <= 7 ? null : "ASCII terms can have at most 7 words.";
}

/** Valid terms only (invalid or duplicate ones are dropped), capped at MAX_HOTWORDS. */
export function buildVocabulary(hotwords: { term: string; weight?: number }[]): Record<string, number> {
  const vocab: Record<string, number> = {};
  for (const { term, weight } of hotwords) {
    const t = term.trim();
    if (validateHotword(t) || t in vocab) continue;
    if (Object.keys(vocab).length >= MAX_HOTWORDS) break;
    const w = Number.isInteger(weight) && weight! >= 1 && weight! <= 5 ? weight! : DEFAULT_HOTWORD_WEIGHT;
    vocab[t] = w;
  }
  return vocab;
}

export function buildSubmitBody(model: string, opts: SubmitOptions) {
  const input: Record<string, unknown> = { file_urls: [opts.fileUrl] };
  const context = [...(opts.context ?? "").trim()].slice(0, ASR_CONTEXT_MAX_CHARS).join("");
  if (context) {
    input.context = [{ role: "user", content: [{ type: "input_text", text: context }] }];
  }
  const parameters: Record<string, unknown> = {
    channel_id: CHANNEL_IDS,
    diarization_enabled: true,
    language_hints: LANGUAGE_HINTS,
  };
  const vocabulary = buildVocabulary(opts.hotwords ?? []);
  if (Object.keys(vocabulary).length > 0) parameters.vocabulary = vocabulary;
  return { model, input, parameters };
}

export type TaskState =
  | { state: "pending" }
  | { state: "succeeded"; transcriptionUrl: string; usage: unknown }
  | { state: "failed"; message: string };

interface TaskResponse {
  code?: string;
  message?: string;
  usage?: unknown;
  output?: {
    task_status?: string;
    code?: string;
    message?: string;
    results?: { subtask_status?: string; transcription_url?: string; code?: string; message?: string }[];
  };
}

/** Interprets GET /tasks/{id}. Unknown statuses count as pending so a later poll can settle them. */
export function parseTaskResponse(json: unknown): TaskState {
  const r = (json ?? {}) as TaskResponse;
  const status = r.output?.task_status;
  if (status === "SUCCEEDED") {
    const first = r.output?.results?.[0];
    if (first?.subtask_status === "SUCCEEDED" && first.transcription_url) {
      return { state: "succeeded", transcriptionUrl: first.transcription_url, usage: r.usage ?? null };
    }
    const why = first?.message || first?.code || "no transcription result returned";
    return { state: "failed", message: `Qwen finished without a result: ${why}` };
  }
  if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
    const why = r.output?.message || r.message || r.output?.code || r.code || status;
    return { state: "failed", message: `Qwen task ${status.toLowerCase()}: ${why}` };
  }
  return { state: "pending" };
}

// ---- Result file (transcription_url JSON); times are milliseconds ----
export interface QwenWord { begin_time: number; end_time: number; text: string; punctuation?: string }
export interface QwenSentence {
  begin_time: number;
  end_time: number;
  text: string;
  sentence_id?: number;
  speaker_id?: number; // present when diarization_enabled
  words?: QwenWord[];
}
export interface QwenTranscript {
  channel_id: number;
  content_duration_in_milliseconds?: number;
  text: string;
  sentences: QwenSentence[];
}
export interface QwenResult {
  file_url?: string;
  properties?: { channels?: number[]; original_duration_in_milliseconds?: number; [k: string]: unknown };
  transcripts: QwenTranscript[];
}
