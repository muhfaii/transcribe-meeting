# Meeting Transcriber

Upload a long meeting recording (m4a, 3+ hours), get a speaker-labelled DOCX.
Runs entirely on Cloudflare's **Free plan** (Workers, R2, D1, Access); speech-to-text is the Qwen API.

**Status: Phase 3 of 5** — m4a upload (browser → R2 multipart), jobs sent to Qwen with speaker diarization,
status checked every 2 minutes by a Cron Trigger, raw transcript saved to R2, and a transcript page with
speaker renaming/merging and DOCX download (built in the browser).
The glossary UI, AI correction pass and deployment hardening come next.
See the plan: thin Worker, heavy browser (the Free plan allows 10 ms CPU per request).

## Local development
```bash
npm install
npm run db:migrate:local
npm run dev          # builds the web bundle, then runs wrangler dev on :8787
# Fake Qwen (no API key needed; a job "finishes" 5 s after upload) + manual Cron trigger:
npx wrangler dev --test-scheduled --var QWEN_MOCK:1
curl 'http://localhost:8787/__scheduled?cron=*/2+*+*+*+*'
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
   npx wrangler secret put DASHSCOPE_API_KEY   # Singapore key, PRIMARY workspace (hotwords need it)
   ```
5. **D1**: `npx wrangler d1 create transcribe-meeting`, paste the id into `wrangler.jsonc`,
   then `npm run db:migrate:remote`.
6. `npm run deploy`.
7. **Login**: add a Cloudflare Access application (free up to 50 users) for the whole hostname.
   The app has no accounts of its own.

## Limits
- m4a only, 1 GiB max (`MAX_UPLOAD_BYTES`), 50 MiB parts, 3 uploaded in parallel.
- Each Worker request only signs ≤5 part URLs, so CPU stays far below 10 ms.

## Phase 0: check the Qwen API with one real clip
Settles the parameter names, result fields and time units before the pipeline is built.
```bash
# 1. Upload a SHORT, non-sensitive clip (1-3 min, 2+ speakers, ideally mixed ID/EN)
npx wrangler r2 object put transcribe-meeting-media/probe/clip.m4a --file clip.m4a --remote
# 2. Make a 1-hour download link Qwen can fetch
export R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=…
URL=$(node scripts/presign-get.mjs probe/clip.m4a)
# 3. Run the probe with a Singapore key from the PRIMARY workspace (hotwords need it).
#    Optional: scripts/qwen-probe.sh "$URL" params.json context.json (see the script header)
DASHSCOPE_API_KEY=sk-… scripts/qwen-probe.sh "$URL"
# 4. Clean up
npx wrangler r2 object delete transcribe-meeting-media/probe/clip.m4a --remote
```
Paste the "Result structure" section of the output back so `src/shared/qwen-config.ts` can be filled in.

## How a job runs
1. Upload finishes → `POST /api/jobs` stores the job and sends it to Qwen
   (`qwen-audio-3.1-asr-flash-filetrans`) with a 24 h presigned link to the audio.
   Context (first 400 characters) goes in `input.context`; glossary terms go in `parameters.vocabulary`.
2. A Cron Trigger (every 2 min) checks running jobs. When Qwen finishes, the result JSON is streamed
   to `transcripts/<job id>/raw.json` in R2 untouched, and the job becomes **Ready to review**
   (`GET /api/jobs/:id/raw`). Failed jobs show the reason and a **Retry** button.
3. All Qwen request/response details live in `src/shared/qwen-config.ts`.
   Not sent yet: a speaker-count hint (the parameter name is not in the docs; stored for later).

## Transcript page and DOCX
Open a finished recording from the list (`#/job/<id>`). The browser loads `raw.json`, merges sentences into
speaker paragraphs (new paragraph on speaker change, a pause over 3 s, or ~90 s / 800 characters), and lets you name
each speaker (saved per recording; two speakers with the same name are merged). **Download DOCX** builds
`[hh:mm:ss] Name: text` paragraphs locally, so the Worker does no heavy work.
Logic lives in `src/shared/transcript.ts` (tested); the DOCX layout is in `src/web/docx.ts`.
