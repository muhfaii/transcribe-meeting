// Pure rules shared by the Worker and the browser.

export const PART_SIZE = 50 * 1024 * 1024; // R2 needs >= 5 MiB per part except the last
export const MAX_SIGN_BATCH = 5; // parts signed per request (keeps Worker CPU tiny)
export const DEFAULT_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GiB

const M4A_TYPES = new Set(["", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac"]);
const UPLOAD_KEY = /^uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.m4a$/;

/** Returns an error message, or null when the file is acceptable. */
export function validateUpload(
  fileName: string,
  size: number,
  contentType: string,
  maxBytes = DEFAULT_MAX_UPLOAD_BYTES,
): string | null {
  if (!/\.m4a$/i.test(fileName)) return "Only .m4a audio files are supported.";
  if (!M4A_TYPES.has(contentType.toLowerCase())) return "File does not look like m4a audio.";
  if (!Number.isFinite(size) || size <= 0) return "File is empty.";
  if (size > maxBytes) {
    return `File is too large (limit ${Math.floor(maxBytes / 1024 / 1024)} MB).`;
  }
  return null;
}

export function partCount(size: number, partSize = PART_SIZE): number {
  return Math.max(1, Math.ceil(size / partSize));
}

export function isUploadKey(key: string): boolean {
  return UPLOAD_KEY.test(key);
}
