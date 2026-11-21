# Meeting Transcriber

Upload a long meeting recording (m4a, 3+ hours), get a speaker-labelled DOCX.
Runs entirely on Cloudflare's **Free plan** (Workers, R2, D1, Access); speech-to-text is the Qwen API.

**Status: Phase 1 of 5** — project scaffold and resumable m4a upload (browser → R2 multipart) with a job list.
Transcription, speaker rename, DOCX export, glossary/context and deployment hardening come next.
See the plan: thin Worker, heavy browser (the Free plan allows 10 ms CPU per request).

## Local development
```bash
npm install
npm run db:migrate:local
npm run dev          # builds the web bundle, then runs wrangler dev on :8787
npm test && npm run typecheck
```
Without R2 credentials, parts are uploaded through the Worker into a local R2 simulation
(`PUT /api/uploads/part`, disabled automatically once credentials exist). This path is for dev only.

## Deploy (Cloudflare dashboard + wrangler)
1. **R2 bucket**: create `transcribe-meeting-media` (or change `bucket_name` and `R2_BUCKET` in `wrangler.jsonc`).
2. **Bucket CORS**: put your site's origin (e.g. `https://transcribe.example.com`) in `scripts/r2-cors.json`, then
   `npx wrangler r2 bucket cors set transcribe-meeting-media --file scripts/r2-cors.json`.
   `ExposeHeaders: ["ETag"]` is required, or the browser cannot finish multipart uploads.
3. **Lifecycle rules** (keeps storage inside the 10 GB free tier):
   ```bash
   npx wrangler r2 bucket lifecycle add transcribe-meeting-media delete-uploads uploads/ --expire-days 1
   npx wrangler r2 bucket lifecycle add transcribe-meeting-media abort-multipart "" --abort-multipart-days 1
   ```
   Cloudflare cleans up in batches, so an upload can live up to about two days.
4. **R2 API token**: R2 → Manage API tokens → *Object Read & Write*, scoped to this bucket. Then:
   ```bash
   npx wrangler secret put R2_ACCOUNT_ID
   npx wrangler secret put R2_ACCESS_KEY_ID
   npx wrangler secret put R2_SECRET_ACCESS_KEY
   ```
5. **D1**: `npx wrangler d1 create transcribe-meeting`, paste the id into `wrangler.jsonc`,
   then `npm run db:migrate:remote`.
6. `npm run deploy`.
7. **Login**: add a Cloudflare Access application (free up to 50 users) for the whole hostname.
   The app has no accounts of its own.

## Limits
- m4a only, 1 GiB max (`MAX_UPLOAD_BYTES`), 50 MiB parts, 3 uploaded in parallel.
- Each Worker request only signs ≤5 part URLs, so CPU stays far below 10 ms.
