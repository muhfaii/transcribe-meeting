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

const app = new Hono<{ Bindings: Env }>();

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
  "id, title, status, error, file_name, size, speaker_count_hint, context, use_correction, created_at, updated_at";

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
  return c.json({ id }, 201);
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
  await c.env.MEDIA.delete(row.r2_key);
  await c.env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

app.notFound((c) => c.json({ error: "Not found." }, 404));

export default app;
