import type { Env } from "./env";
import { QWEN_DEFAULT_BASE_URL, QWEN_DEFAULT_MODEL, SUBMIT_PATH, parseTaskResponse, taskPath } from "../shared/qwen-config";
import type { TaskState } from "../shared/qwen-config";
import { MOCK_RESULT, MOCK_URL_PREFIX, mockTaskId, mockTaskResponse } from "./mock";

const isMock = (env: Env) => env.QWEN_MOCK === "1";
const baseUrl = (env: Env) => (env.QWEN_BASE_URL || QWEN_DEFAULT_BASE_URL).replace(/\/+$/, "");
export const qwenModel = (env: Env) => env.QWEN_ASR_MODEL || QWEN_DEFAULT_MODEL;

async function qwenFetch(env: Env, path: string, init: RequestInit = {}): Promise<unknown> {
  if (!env.DASHSCOPE_API_KEY) throw new Error("DASHSCOPE_API_KEY is not set.");
  const res = await fetch(baseUrl(env) + path, {
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
    const j = json as { code?: string; message?: string } | null;
    throw new Error(`Qwen API ${res.status}: ${j?.message || j?.code || text.slice(0, 200)}`);
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
