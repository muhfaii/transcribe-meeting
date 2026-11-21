# Meeting Transcriber

Upload a long meeting recording (m4a, 3+ hours), get a speaker-labelled DOCX.
Runs entirely on Cloudflare's **Free plan** (Workers, R2, D1, Access); speech-to-text is the Qwen API.

**Status: Phase 5 of 5 (deployment prep)** — upload, Qwen transcription with speaker diarization, transcript page,
speaker rename/merge, DOCX, glossary and AI correction are built and tested locally against fakes.
Not deployed yet (follow [DEPLOY.md](DEPLOY.md)). The Qwen request/result format, hotwords and the chat model were checked
live; mixed-language audio and recordings over 2 hours have not been tested.
See the plan: thin Worker, heavy browser (the Free plan allows 10 ms CPU per request).

## Local development
```bash
npm install
npm run db:migrate:local
npm run dev          # builds the web bundle, then runs wrangler dev on :8787
# Fake Qwen (no API key needed; a job "finishes" 5 s after upload) + manual Cron trigger:
npx wrangler dev --test-scheduled --var REQUIRE_ACCESS:0 --var QWEN_MOCK:1
curl 'http://localhost:8787/__scheduled?cron=*/2+*+*+*+*'
npm test && npm run typecheck
```
Without R2 credentials, parts are uploaded through the Worker into a local R2 simulation
(`PUT /api/uploads/part`, disabled automatically once credentials exist). This path is for dev only.

## Deploy
See **[DEPLOY.md](DEPLOY.md)**: a step-by-step checklist (bucket, lifecycle rules, D1, secrets, Cloudflare Access, CORS),
`scripts/smoke.sh` for a post-deploy check, cost guards, and rollback.
`REQUIRE_ACCESS` defaults to on in `wrangler.jsonc`: without `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` the API refuses every request.
`npm run dev` turns it off for local use.

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

## Glossary and AI correction
- **Glossary** (`#/glossary`): names and jargon shared by every recording. They are sent to the speech model as
  instant hotwords (`parameters.vocabulary`) and given to the AI correction as reference spellings.
  The model's text rules are checked as you type (non-ASCII ≤ 15 characters, ASCII ≤ 7 words, ≤ 2000 terms).
- **AI correction**: the browser sends the transcript in chunks of ≤ 60 paragraphs to
  `POST /api/jobs/:id/correct`; the Worker builds the prompt (meeting context + glossary) and calls a Qwen chat model.
  Replies are validated per paragraph (JSON only, known indexes, no big length changes, no Chinese↔Latin
  swaps); anything doubtful keeps the original text. It is all-or-nothing: the result is saved
  (`transcripts/<id>/segments.json`, status **Done**) only if every chunk succeeds. **Use original text** switches the
  preview and DOCX back to the uncorrected transcript at any time, and **Re-run** repeats the pass.
  It runs automatically the first time you open a recording that has "Fix names/terms with AI" ticked.
- **Chat endpoint and model** (`<QWEN_BASE_URL>/compatible-mode/v1/chat/completions`, `qwen-plus`) were checked live and work.
  Override with `QWEN_CHAT_URL` / `QWEN_CHAT_MODEL` (wrangler vars) if needed; `scripts/qwen-chat-probe.sh` re-checks them.
  With `QWEN_MOCK=1` a fake reply is used instead.
- **What was verified live** (4 s sample clip): hotwords fix a misheard name; `input.context` did not change the transcript.
  So the glossary (hotwords) and the AI correction carry the accuracy; the context box mainly feeds the AI correction.
