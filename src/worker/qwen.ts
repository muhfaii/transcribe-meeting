import type { Env } from "./env";
import {
  QWEN_CHAT_PATH,
  QWEN_DEFAULT_BASE_URL,
  QWEN_DEFAULT_CHAT_MODEL,
  QWEN_DEFAULT_MODEL,
  SUBMIT_PATH,
  parseTaskResponse,
  taskPath,
} from "../shared/qwen-config";
import type { TaskState } from "../shared/qwen-config";
import { MOCK_RESULT, MOCK_URL_PREFIX, mockCorrectionReply, mockTaskId, mockTaskResponse } from "./mock";

const isMock = (env: Env) => env.QWEN_MOCK === "1";
const baseUrl = (env: Env) => (env.QWEN_BASE_URL || QWEN_DEFAULT_BASE_URL).replace(/\/+$/, "");
export const qwenModel = (env: Env) => env.QWEN_ASR_MODEL || QWEN_DEFAULT_MODEL;

async function qwenFetch(env: Env, path: string, init: RequestInit = {}, fullUrl?: string): Promise<unknown> {
  if (!env.DASHSCOPE_API_KEY) throw new Error("DASHSCOPE_API_KEY is not set.");
  const res = await fetch(fullUrl ?? baseUrl(env) + path, {
    ...init,
    headers: { Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`, "Content-Type": "application/json", ...init.headers },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON error body; keep the text below
  }
  if (!res.ok) {
    // DashScope style {code, message} or OpenAI style {error: {message, code}}
    const j = json as { code?: string; message?: string; error?: { code?: string; message?: string } } | null;
    const why = j?.message || j?.error?.message || j?.code || j?.error?.code || text.slice(0, 200);
    throw new Error(`Qwen API ${res.status}: ${why}`);
  }
  return json;
}

/** Submits an async transcription task and returns its task_id. */
export async function submitTask(env: Env, body: unknown): Promise<string> {
  if (isMock(env)) return mockTaskId();
  const json = (await qwenFetch(env, SUBMIT_PATH, {
    method: "POST",
    headers: { "X-DashScope-Async": "enable" },
    body: JSON.stringify(body),
  })) as { output?: { task_id?: string; message?: string } } | null;
  const id = json?.output?.task_id;
  if (!id) throw new Error(`Qwen did not return a task id${json?.output?.message ? `: ${json.output.message}` : "."}`);
  return id;
}

export async function fetchTask(env: Env, taskId: string): Promise<TaskState> {
  if (isMock(env)) return parseTaskResponse(mockTaskResponse(taskId));
  return parseTaskResponse(await qwenFetch(env, taskPath(taskId)));
}

/** Downloads the finished transcription JSON (a public, 24 h link; no auth header). */
export async function downloadResult(env: Env, url: string): Promise<Response> {
  if (isMock(env) && url.startsWith(MOCK_URL_PREFIX)) {
    return new Response(JSON.stringify(MOCK_RESULT), { headers: { "content-type": "application/json" } });
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the transcription (${res.status}).`);
  return res;
}

export const chatModel = (env: Env) => env.QWEN_CHAT_MODEL || QWEN_DEFAULT_CHAT_MODEL;

/** One chat completion (OpenAI-compatible request/response). Returns the assistant text. */
export async function chatComplete(env: Env, messages: { role: string; content: string }[]): Promise<string> {
  if (isMock(env)) return mockCorrectionReply(messages[messages.length - 1].content);
  const url = env.QWEN_CHAT_URL || baseUrl(env) + QWEN_CHAT_PATH;
  const json = (await qwenFetch(
    env,
    "",
    { method: "POST", body: JSON.stringify({ model: chatModel(env), messages, temperature: 0 }) },
    url,
  )) as { choices?: { message?: { content?: string } }[] } | null;
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Qwen chat returned no text.");
  return content;
}
