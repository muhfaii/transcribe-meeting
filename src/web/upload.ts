import type { CompletedPart, SignedPart, UploadInit } from "../shared/types";
import { MAX_SIGN_BATCH } from "../shared/upload-rules";

const CONCURRENCY = 3;
const RETRIES = 3;

async function api<T>(path: string, body: unknown, method = "POST"): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

/** PUT one part with XHR so we get upload progress events. Resolves with the ETag. */
function putPart(url: string, blob: Blob, onProgress: (loaded: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onerror = () => reject(new Error("Network error while uploading."));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(`Upload failed (${xhr.status}).`));
      const etag = xhr.getResponseHeader("ETag");
      if (!etag) return reject(new Error("Storage did not return an ETag (check the bucket CORS rule)."));
      resolve(etag);
    };
    xhr.send(blob);
  });
}

export interface UploadResult {
  key: string;
}

export async function uploadFile(
  file: File,
  onProgress: (loadedBytes: number, totalBytes: number) => void,
): Promise<UploadResult> {
  const init = await api<UploadInit>("/api/uploads", {
    fileName: file.name,
    size: file.size,
    contentType: file.type,
  });

  const loaded = new Map<number, number>();
  const report = () => {
    let sum = 0;
    for (const v of loaded.values()) sum += v;
    onProgress(Math.min(sum, file.size), file.size);
  };

  const done: CompletedPart[] = [];
  const queue = Array.from({ length: init.partCount }, (_, i) => i + 1);

  const signBatch = async (numbers: number[]): Promise<SignedPart[]> =>
    (await api<{ parts: SignedPart[] }>("/api/uploads/sign", {
      key: init.key,
      uploadId: init.uploadId,
      partNumbers: numbers,
    })).parts;

  async function uploadPart(partNumber: number): Promise<void> {
    const start = (partNumber - 1) * init.partSize;
    const blob = file.slice(start, Math.min(start + init.partSize, file.size));
    let lastError: unknown;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        // Re-sign on every attempt: a retry may be long after the first URL was issued.
        const [signed] = await signBatch([partNumber]);
        const etag = await putPart(signed.url, blob, (n) => {
          loaded.set(partNumber, n);
          report();
        });
        loaded.set(partNumber, blob.size);
        report();
        done.push({ partNumber, etag });
        return;
      } catch (err) {
        lastError = err;
        loaded.set(partNumber, 0);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Upload failed.");
  }

  try {
    let failure: unknown;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length && !failure) {
        const next = queue.shift()!;
        try {
          await uploadPart(next);
        } catch (err) {
          failure = err;
        }
      }
    });
    await Promise.all(workers);
    if (failure) throw failure;
    await api("/api/uploads/complete", { key: init.key, uploadId: init.uploadId, parts: done });
  } catch (err) {
    await api("/api/uploads/abort", { key: init.key, uploadId: init.uploadId }).catch(() => {});
    throw err;
  }
  return { key: init.key };
}

export { api, MAX_SIGN_BATCH };
