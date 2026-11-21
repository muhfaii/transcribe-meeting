export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  R2_BUCKET: string;
  MAX_UPLOAD_BYTES?: string;
  QWEN_BASE_URL?: string;
  QWEN_ASR_MODEL?: string;
  /** "1" = fake Qwen (local dev / tests). */
  QWEN_CHAT_URL?: string;
  QWEN_CHAT_MODEL?: string;
  QWEN_MOCK?: string;
  DASHSCOPE_API_KEY?: string;
  // Secrets. When absent (local dev), parts are uploaded through the Worker instead.
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}
