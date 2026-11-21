import { applyCorrections, chunkTurns, type CorrectionItem } from "../shared/correction";
import type { Turn } from "../shared/transcript";

const CONCURRENCY = 3;
const RETRIES = 2;

async function correctChunk(jobId: string, items: CorrectionItem[], signal: AbortSignal): Promise<CorrectionItem[]> {
  let lastError = "Correction failed.";
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    try {
      const res = await fetch(`/api/jobs/${jobId}/correct`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items }),
        signal,
      });
      const data = (await res.json().catch(() => ({}))) as { items?: CorrectionItem[]; error?: string };
      if (res.ok) return data.items ?? [];
      lastError = data.error || `Request failed (${res.status})`;
      if (res.status >= 400 && res.status < 500) break; // retrying a rejected request will not help
    } catch (e) {
      if (signal.aborted) throw e;
      lastError = e instanceof Error ? e.message : lastError;
    }
    await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
  }
  throw new Error(lastError);
}

/**
 * Runs the AI correction over all turns in chunks. All-or-nothing: if any chunk keeps failing, this throws
 * and nothing is applied, so a half-corrected transcript is never saved.
 */
export async function runCorrection(
  jobId: string,
  turns: Turn[],
  onProgress: (done: number, total: number) => void,
  signal: AbortSignal,
): Promise<Turn[]> {
  const chunks = chunkTurns(turns);
  const corrections: CorrectionItem[] = [];
  let next = 0;
  let done = 0;
  onProgress(0, chunks.length);

  let failure: unknown;
  const workers = Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, async () => {
    while (next < chunks.length && !failure) {
      const chunk = chunks[next++];
      try {
        corrections.push(...(await correctChunk(jobId, chunk, signal)));
        onProgress(++done, chunks.length);
      } catch (e) {
        failure = e;
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
  return applyCorrections(turns, corrections);
}
