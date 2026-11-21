import type { Env } from "./env";
import { buildSubmitBody } from "../shared/qwen-config";
import { createR2Client, hasR2Credentials, presignGetUrl } from "./r2presign";
import { downloadResult, fetchTask, qwenModel, submitTask } from "./qwen";

const MAX_POLLS_PER_RUN = 8; // keeps each Cron run under the Free plan's subrequest limit
const GIVE_UP_AFTER_MS = 12 * 60 * 60 * 1000;

export const rawKey = (jobId: string) => `transcripts/${jobId}/raw.json`;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

async function fail(env: Env, id: string, message: string) {
  await env.DB.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
    .bind(message, Date.now(), id)
    .run();
}

/** Sends one uploaded job to Qwen. Never throws: problems become status 'failed' + a message. */
export async function submitJob(env: Env, id: string): Promise<void> {
  try {
    const job = await env.DB.prepare("SELECT r2_key, context FROM jobs WHERE id = ?")
      .bind(id)
      .first<{ r2_key: string; context: string }>();
    if (!job) return;
    if (!(await env.MEDIA.head(job.r2_key))) {
      return await fail(env, id, "The audio is no longer stored (uploads are kept for about a day). Upload it again.");
    }

    let fileUrl: string;
    if (env.QWEN_MOCK === "1") {
      fileUrl = `mock://${job.r2_key}`;
    } else if (hasR2Credentials(env)) {
      fileUrl = await presignGetUrl(createR2Client(env), {
        accountId: env.R2_ACCOUNT_ID!,
        bucket: env.R2_BUCKET,
        key: job.r2_key,
      });
    } else {
      return await fail(env, id, "R2 credentials are not configured, so Qwen cannot download the audio.");
    }

    const { results } = await env.DB.prepare("SELECT term FROM glossary ORDER BY id LIMIT 2000").all<{ term: string }>();
    const body = buildSubmitBody(qwenModel(env), {
      fileUrl,
      context: job.context,
      hotwords: results.map((r) => ({ term: r.term })),
    });
    const taskId = await submitTask(env, body);
    await env.DB.prepare("UPDATE jobs SET status = 'running', qwen_task_id = ?, error = NULL, updated_at = ? WHERE id = ?")
      .bind(taskId, Date.now(), id)
      .run();
  } catch (e) {
    await fail(env, id, messageOf(e));
  }
}

async function pollOne(env: Env, job: { id: string; qwen_task_id: string; created_at: number }) {
  if (Date.now() - job.created_at > GIVE_UP_AFTER_MS) {
    return await fail(env, job.id, "Timed out waiting for Qwen.");
  }
  const state = await fetchTask(env, job.qwen_task_id);
  if (state.state === "pending") {
    await env.DB.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").bind(Date.now(), job.id).run();
    return;
  }
  if (state.state === "failed") return await fail(env, job.id, state.message);

  // Save the raw result untouched; the browser parses it (the Worker has only ~10 ms CPU per run on Free).
  const res = await downloadResult(env, state.transcriptionUrl);
  const type = { httpMetadata: { contentType: "application/json" } };
  if (res.headers.get("content-length") && res.body) {
    await env.MEDIA.put(rawKey(job.id), res.body, type); // streamed, never held in memory
  } else {
    await env.MEDIA.put(rawKey(job.id), await res.arrayBuffer(), type);
  }
  await env.DB.prepare("UPDATE jobs SET status = 'transcribed', usage = ?, error = NULL, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(state.usage ?? null), Date.now(), job.id)
    .run();
}

/** Cron entry point: checks running jobs. Transient errors leave the job running for the next run. */
export async function pollRunningJobs(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id, qwen_task_id, created_at FROM jobs WHERE status = 'running' AND qwen_task_id IS NOT NULL ORDER BY updated_at ASC LIMIT ?",
  )
    .bind(MAX_POLLS_PER_RUN)
    .all<{ id: string; qwen_task_id: string; created_at: number }>();
  for (const job of results) {
    try {
      await pollOne(env, job);
    } catch (e) {
      console.error(`poll ${job.id}: ${messageOf(e)}`);
    }
  }
}
