export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  R2_BUCKET: string;
  MAX_UPLOAD_BYTES?: string;
  // Secrets. When absent (local dev), parts are uploaded through the Worker instead.
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}
