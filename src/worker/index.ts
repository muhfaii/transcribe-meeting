import { Hono } from "hono";
import type { Env } from "./env";
import { createR2Client, hasR2Credentials, presignPartUrl } from "./r2presign";
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  MAX_SIGN_BATCH,
  PART_SIZE,
  isUploadKey,
  partCount,
  validateUpload,
} from "../shared/upload-rules";
import type { CompletedPart, SignedPart, UploadInit } from "../shared/types";
import { checkAccess } from "./access";
import { pollRunningJobs, rawKey, segmentsKey, submitJob } from "./pipeline";
import { chatComplete } from "./qwen";
import { MAX_HOTWORDS, validateHotword } from "../shared/qwen-config";
import {
  MAX_CHARS_PER_REQUEST,
  MAX_ITEMS_PER_REQUEST,
  buildCorrectionMessages,
  parseCorrectionResponse,
  type CorrectionItem,
} from "../shared/correction";

const app = new Hono<{ Bindings: Env }>();

// Every API route requires a valid Cloudflare Access login (fail-closed; see access.ts).
app.use("/api/*", async (c, next) => {
  const access = await checkAccess(c.env, c.req.raw);
  if (access.enforce && !access.ok) return c.json({ error: access.message }, access.status);
  await next();
});

const maxBytes = (env: Env) => Number(env.MAX_UPLOAD_BYTES) || DEFAULT_MAX_UPLOAD_BYTES;

async function readJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<Partial<T>> {
  try {
    return ((await c.req.json()) ?? {}) as Partial<T>;
  } catch {
    return {};
  }
}

// ---- Uploads (R2 multipart; the browser PUTs parts straight to R2) ----

app.post("/api/uploads", async (c) => {
  const body = await readJson<{ fileName: string; size: number; contentType: string }>(c);
  const error = validateUpload(
    String(body.fileName ?? ""),
    Number(body.size),
    String(body.contentType ?? ""),
    maxBytes(c.env),
  );
  if (error) return c.json({ error }, 400);

  const key = `uploads/${crypto.randomUUID()}.m4a`;
  const upload = await c.env.MEDIA.createMultipartUpload(key, {
    httpMetadata: { contentType: "audio/mp4" },
  });
  const init: UploadInit = {
    key,
    uploadId: upload.uploadId,
    partSize: PART_SIZE,
    partCount: partCount(Number(body.size)),
  };
  return c.json(init);
});

// Sign a few parts at a time so each request stays far below the 10 ms Free-plan CPU limit.
app.post("/api/uploads/sign", async (c) => {
  const body = await readJson<{ key: string; uploadId: string; partNumbers: number[] }>(c);
  const { key, uploadId } = body;
  const nums = body.partNumbers;
  if (!key || !isUploadKey(key) || !uploadId || !Array.isArray(nums)) {
    return c.json({ error: "Invalid request." }, 400);
  }
  if (nums.length === 0 || nums.length > MAX_SIGN_BATCH) {
    return c.json({ error: `Sign 1-${MAX_SIGN_BATCH} parts per request.` }, 400);
  }
  const limit = Math.ceil(maxBytes(c.env) / PART_SIZE);
  if (!nums.every((n) => Number.isInteger(n) && n >= 1 && n <= limit)) {
    return c.json({ error: "Invalid part number." }, 400);
  }

  const parts: SignedPart[] = [];
  if (hasR2Credentials(c.env)) {
    const client = createR2Client(c.env);
    for (const partNumber of nums) {
      parts.push({
        partNumber,
        url: await presignPartUrl(client, {
          accountId: c.env.R2_ACCOUNT_ID!,
          bucket: c.env.R2_BUCKET,
          key,
          uploadId,
          partNumber,
        }),
      });
    }
  } else {
    // Local dev fallback: same-origin upload through the Worker (not for production).
    for (const partNumber of nums) {
      const q = new URLSearchParams({ key, uploadId, partNumber: String(partNumber) });
      parts.push({ partNumber, url: `/api/uploads/part?${q}` });
    }
  }
  return c.json({ parts });
});

app.put("/api/uploads/part", async (c) => {
  if (hasR2Credentials(c.env)) return c.json({ error: "Not available." }, 404);
  const key = c.req.query("key") ?? "";
  const uploadId = c.req.query("uploadId") ?? "";
  const partNumber = Number(c.req.query("partNumber"));
  if (!isUploadKey(key) || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
    return c.json({ error: "Invalid request." }, 400);
  }
  const part = await c.env.MEDIA.resumeMultipartUpload(key, uploadId).uploadPart(
    partNumber,
    c.req.raw.body!,
  );
  return new Response(null, { status: 200, headers: { ETag: part.etag } });
});

app.post("/api/uploads/complete", async (c) => {
  const body = await readJson<{ key: string; uploadId: string; parts: CompletedPart[] }>(c);
  const { key, uploadId, parts } = body;
  if (!key || !isUploadKey(key) || !uploadId || !Array.isArray(parts) || parts.length === 0) {
    return c.json({ error: "Invalid request." }, 400);
  }
  const sorted = [...parts]
    .map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) }))
    .sort((a, b) => a.partNumber - b.partNumber);

  const object = await c.env.MEDIA.resumeMultipartUpload(key, uploadId).complete(sorted);
  // Presigned parts cannot be size-checked in advance, so enforce the cap afterwards.
  if (object.size > maxBytes(c.env)) {
    await c.env.MEDIA.delete(key);
    return c.json({ error: "File is too large." }, 413);
  }
  return c.json({ key, size: object.size });
});

app.post("/api/uploads/abort", async (c) => {
  const { key, uploadId } = await readJson<{ key: string; uploadId: string }>(c);
  if (!key || !isUploadKey(key) || !uploadId) return c.json({ error: "Invalid request." }, 400);
  try {
    await c.env.MEDIA.resumeMultipartUpload(key, uploadId).abort();
  } catch {
    // Already completed or aborted; nothing to do.
  }
  return c.json({ ok: true });
});

// ---- Jobs ----

const JOB_COLUMNS =
  "id, title, status, error, file_name, size, speaker_count_hint, context, use_correction, usage, created_at, updated_at";

app.post("/api/jobs", async (c) => {
  const body = await readJson<{
    r2Key: string;
    fileName: string;
    title: string;
    context: string;
    speakerCount: number | null;
    correction: boolean;
  }>(c);
  const r2Key = String(body.r2Key ?? "");
  if (!isUploadKey(r2Key)) return c.json({ error: "Invalid upload." }, 400);
  const head = await c.env.MEDIA.head(r2Key);
  if (!head) return c.json({ error: "Upload not found." }, 404);

  // Spend guard: every recording costs speech-model (and optionally chat) usage.
  const cap = Number(c.env.MAX_JOBS_PER_DAY) || 30;
  const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE created_at > ?")
    .bind(Date.now() - 24 * 3600 * 1000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= cap) {
    return c.json({ error: `Daily limit reached (${cap} recordings per 24 hours). Try again later or raise MAX_JOBS_PER_DAY.` }, 429);
  }

  const fileName = String(body.fileName ?? "recording.m4a").slice(0, 200);
  const title = String(body.title ?? "").trim().slice(0, 200) || fileName.replace(/\.m4a$/i, "");
  const context = String(body.context ?? "").slice(0, 4000);
  const hint = Number(body.speakerCount);
  const speakerCount = Number.isInteger(hint) && hint >= 1 && hint <= 20 ? hint : null;
  const now = Date.now();
  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO jobs (id, title, status, r2_key, file_name, size, speaker_count_hint, context, use_correction, created_at, updated_at)
     VALUES (?, ?, 'uploaded', ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, title, r2Key, fileName, head.size, speakerCount, context, body.correction === false ? 0 : 1, now, now)
    .run();
  await submitJob(c.env, id); // sends the audio to Qwen; a failure is recorded on the job
  return c.json({ id }, 201);
});

app.post("/api/jobs/:id/retry", async (c) => {
  const id = c.req.param("id");
  const job = await c.env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(id).first<{ status: string }>();
  if (!job) return c.json({ error: "Not found." }, 404);
  if (job.status !== "failed") return c.json({ error: "Only failed jobs can be retried." }, 409);
  await submitJob(c.env, id);
  return c.json({ ok: true });
});

// Custom speaker names (default names are computed in the browser from the transcript).
const SPEAKER_KEY = /^(\d{1,3}|\?)$/;

app.get("/api/jobs/:id/speakers", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT speaker_key, display_name FROM speakers WHERE job_id = ?")
    .bind(c.req.param("id"))
    .all<{ speaker_key: string; display_name: string }>();
  return c.json({ names: Object.fromEntries(results.map((r) => [r.speaker_key, r.display_name])) });
});

app.put("/api/jobs/:id/speakers", async (c) => {
  const id = c.req.param("id");
  const { names } = await readJson<{ names: Record<string, string> }>(c);
  if (!names || typeof names !== "object" || Array.isArray(names)) return c.json({ error: "Invalid request." }, 400);
  const entries = Object.entries(names)
    .map(([k, v]) => [k, String(v ?? "").trim().slice(0, 60)] as const)
    .filter(([, v]) => v !== "");
  if (entries.length > 30 || entries.some(([k]) => !SPEAKER_KEY.test(k))) return c.json({ error: "Invalid speakers." }, 400);
  if (!(await c.env.DB.prepare("SELECT 1 FROM jobs WHERE id = ?").bind(id).first())) return c.json({ error: "Not found." }, 404);

  // Replace the whole set; an empty name means "use the default".
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM speakers WHERE job_id = ?").bind(id),
    ...entries.map(([k, v]) =>
      c.env.DB.prepare("INSERT INTO speakers (job_id, speaker_key, display_name) VALUES (?, ?, ?)").bind(id, k, v),
    ),
  ]);
  return c.json({ ok: true });
});

app.get("/api/jobs/:id/raw", async (c) => {
  const object = await c.env.MEDIA.get(rawKey(c.req.param("id")));
  if (!object) return c.json({ error: "No transcript yet." }, 404);
  return new Response(object.body, {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
});

app.get("/api/jobs", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ${JOB_COLUMNS} FROM jobs ORDER BY created_at DESC LIMIT 100`,
  ).all();
  return c.json({ jobs: results });
});

app.get("/api/jobs/:id", async (c) => {
  const job = await c.env.DB.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`)
    .bind(c.req.param("id"))
    .first();
  return job ? c.json(job) : c.json({ error: "Not found." }, 404);
});

app.delete("/api/jobs/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT r2_key FROM jobs WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ r2_key: string }>();
  if (!row) return c.json({ error: "Not found." }, 404);
  await c.env.MEDIA.delete([row.r2_key, rawKey(c.req.param("id")), segmentsKey(c.req.param("id"))]);
  await c.env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// ---- Corrected transcript (browser-produced; the Worker only stores it) ----
const MAX_RESULT_BYTES = 5 * 1024 * 1024;

app.get("/api/jobs/:id/result", async (c) => {
  const object = await c.env.MEDIA.get(segmentsKey(c.req.param("id")));
  if (!object) return c.json({ error: "No corrected transcript." }, 404);
  return new Response(object.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
});

app.put("/api/jobs/:id/result", async (c) => {
  const id = c.req.param("id");
  const length = Number(c.req.header("content-length"));
  if (!Number.isFinite(length) || length <= 0 || length > MAX_RESULT_BYTES) return c.json({ error: "Invalid size." }, 413);
  const job = await c.env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(id).first<{ status: string }>();
  if (!job) return c.json({ error: "Not found." }, 404);
  if (job.status !== "transcribed" && job.status !== "done") return c.json({ error: "Transcript is not ready." }, 409);
  await c.env.MEDIA.put(segmentsKey(id), c.req.raw.body!, { httpMetadata: { contentType: "application/json" } });
  await c.env.DB.prepare("UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
  return c.json({ ok: true });
});

// ---- AI correction: the browser sends small chunks; the prompt is built here, never by the client ----
app.post("/api/jobs/:id/correct", async (c) => {
  const { items } = await readJson<{ items: CorrectionItem[] }>(c);
  const valid =
    Array.isArray(items) &&
    items.length > 0 &&
    items.length <= MAX_ITEMS_PER_REQUEST &&
    items.every((it) => Number.isInteger(it?.i) && it.i >= 0 && typeof it.text === "string");
  if (!valid) return c.json({ error: "Invalid items." }, 400);
  if (items!.reduce((n, it) => n + it.text.length, 0) > MAX_CHARS_PER_REQUEST) return c.json({ error: "Chunk too large." }, 413);

  const job = await c.env.DB.prepare("SELECT context FROM jobs WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ context: string }>();
  if (!job) return c.json({ error: "Not found." }, 404);
  const { results } = await c.env.DB.prepare("SELECT term, note FROM glossary ORDER BY id LIMIT 200").all<{ term: string; note: string }>();

  try {
    const reply = await chatComplete(c.env, buildCorrectionMessages({ context: job.context, terms: results, items: items! }));
    return c.json({ items: parseCorrectionResponse(reply, items!) });
  } catch (e) {
    return c.json({ error: (e instanceof Error ? e.message : "Correction failed.").slice(0, 300) }, 502);
  }
});

// ---- Glossary (shared by every job: ASR hotwords + correction reference) ----
app.get("/api/glossary", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, term, note FROM glossary ORDER BY term COLLATE NOCASE").all();
  return c.json({ terms: results });
});

app.post("/api/glossary", async (c) => {
  const body = await readJson<{ term: string; note: string }>(c);
  const term = String(body.term ?? "").trim();
  const note = String(body.note ?? "").trim().slice(0, 200);
  const problem = validateHotword(term);
  if (problem) return c.json({ error: problem }, 400);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM glossary").first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_HOTWORDS) return c.json({ error: `The glossary is full (${MAX_HOTWORDS} terms).` }, 409);
  try {
    const res = await c.env.DB.prepare("INSERT INTO glossary (term, note) VALUES (?, ?)").bind(term, note).run();
    return c.json({ id: res.meta.last_row_id, term, note }, 201);
  } catch {
    return c.json({ error: "That term is already in the glossary." }, 409);
  }
});

app.delete("/api/glossary/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM glossary WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

app.notFound((c) => c.json({ error: "Not found." }, 404));

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(pollRunningJobs(env));
  },
};
