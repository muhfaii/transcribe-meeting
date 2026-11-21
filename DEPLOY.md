# Deployment checklist (Cloudflare Free plan)

Do this from **your own machine** (it needs a browser login to Cloudflare). Tick each box; every step says how to
check it worked. The first deploy is safe: until Access is configured (step 6) the API answers
`503 Access is required but not configured` and nothing can be uploaded or spent.

**Before you start:** a Cloudflare account, Node 22+, a Qwen API key for **Singapore (ap-southeast-1)** from your
**primary workspace** (hotwords do not work in sub-workspaces), and ideally a domain on Cloudflare.
R2 may ask for a payment method to activate; the free tier (10 GB) still applies and you are only charged above it.

## 0. Pre-flight
- [ ] `npm ci && npm run check` — typecheck, tests, build and a deploy dry run all pass.
- [ ] `npx wrangler login` (browser). Check: `npx wrangler whoami` shows your account.

## 1. Storage
- [ ] Create the bucket: `npx wrangler r2 bucket create transcribe-meeting-media`
- [ ] Delete uploads after a day and clean up abandoned multipart uploads (keeps you inside the 10 GB free tier):
  ```bash
  npx wrangler r2 bucket lifecycle add transcribe-meeting-media delete-uploads uploads/ --expire-days 1
  npx wrangler r2 bucket lifecycle add transcribe-meeting-media abort-multipart --abort-multipart-days 1
  npx wrangler r2 bucket lifecycle list transcribe-meeting-media
  ```
  Check: both rules are listed. (Cloudflare cleans up in batches, so an upload can live up to ~2 days. Transcripts
  under `transcripts/` are kept.)
- [ ] Create an R2 API token: Dashboard → R2 → *Manage R2 API tokens* → Create → **Object Read & Write**, limited to
  this bucket. Keep the **Access Key ID**, **Secret Access Key** and your **Account ID** (R2 overview page).

## 2. Database
- [ ] `npx wrangler d1 create transcribe-meeting` → copy the printed `database_id` into `wrangler.jsonc`
  (replace `REPLACE_WITH_YOUR_D1_ID`).
- [ ] `npm run db:migrate:remote`. Check: `npx wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type='table'"`
  lists `jobs`, `speakers`, `glossary`.

## 3. First deploy (safe: API is closed until step 6)
- [ ] `npm run deploy`. Note the URL it prints (`https://transcribe-meeting.<you>.workers.dev`).
  Check: the page loads, but `…/api/jobs` returns `503 … not configured`.

## 4. Secrets
```bash
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put DASHSCOPE_API_KEY      # Singapore key, primary workspace
```
- [ ] All four set. Check: `npx wrangler secret list`.

## 5. Custom domain (recommended)
- [ ] Dashboard → Workers & Pages → `transcribe-meeting` → Settings → Domains & Routes → add e.g. `transcribe.example.com`.
- [ ] Once it works, optionally add `"workers_dev": false` to `wrangler.jsonc` so the `*.workers.dev` address is gone.
  (Even without that, the API stays closed: the Worker verifies the Access login itself.)

## 6. Cloudflare Access (the login)
- [ ] Zero Trust (free for up to 50 users) → Access → Applications → Add → **Self-hosted**.
  Application domain: your custom domain, **and** the `workers.dev` host if you kept it. Policy: *Allow* → your email(s).
- [ ] Copy the application's **Audience (AUD) tag** and your **team domain** (`<team>.cloudflareaccess.com`).
- [ ] Put both in `wrangler.jsonc` under `vars`, then `npm run deploy`:
  ```jsonc
  "ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com",
  "ACCESS_AUD": "<aud tag>"
  ```
  Check: opening the site asks you to sign in; afterwards the recordings list loads. In a private window, `…/api/jobs`
  must redirect to the login or answer 401/403.

## 7. Browser uploads (R2 CORS)
- [ ] Put your final site origin in `scripts/r2-cors.json` (e.g. `https://transcribe.example.com`; no trailing slash), then
  `npx wrangler r2 bucket cors set transcribe-meeting-media --file scripts/r2-cors.json`.
  Without this, uploads fail at the first part with a network/ETag error. `ExposeHeaders: ["ETag"]` is required.

## 8. Smoke test (no Qwen spend)
- [ ] Zero Trust → Access → Service auth → create a **service token**; add a **Service Auth** policy to your app.
- [ ] ```bash
  export CF_ACCESS_CLIENT_ID=…  CF_ACCESS_CLIENT_SECRET=…
  scripts/smoke.sh https://transcribe.example.com
  ```
  Check: "Smoke test passed" — covers protection, D1, the R2 binding and R2 secrets. (Delete the service token afterwards
  if you will not reuse it.)

## 9. Real checks with the Qwen API (these are what I could not test)
- Already verified live from the build sandbox (2026-11-21), so no need to repeat: the Qwen submit/poll/result format,
  diarization output (`speaker_id`, times in ms), hotwords fixing a misheard name, and the chat endpoint + `qwen-plus`
  (`scripts/qwen-chat-probe.sh` re-checks the last one).
- [ ] Still untested: run `scripts/qwen-probe.sh` (README, "Phase 0") on a short **mixed Indonesian/English clip with 2+ speakers**
  and check language switching and speaker separation on the transcript page.
- [ ] **Short end-to-end:** upload a 2-3 minute m4a with two speakers. Expect: *Sending to Qwen…* → *Transcribing…* →
  *Ready* within a few minutes (the Cron job runs every 2 minutes). Open it: speakers separated, AI pass runs, names
  can be set, the DOCX opens in Word with `[hh:mm:ss] Name: text`.
- [ ] Dashboard → Workers → `transcribe-meeting` → Logs/Metrics: no errors, and **CPU time stays well under 10 ms**
  (the Free-plan limit), including for the Cron runs.

## 10. The 3-hour test (after step 9 passes)
- [ ] Upload a ~3 h m4a on a normal connection. Watch: upload time, status, result size, whether diarization works
  beyond 2 hours (the docs advise ≤ 2 h; if it fails, the fallback is splitting — ask Claude to build it).
- [ ] Check the cost in the Qwen console and R2 usage in the Cloudflare dashboard; measured ≈ 12 input tokens per audio second,
  so ≈ $0.04 per 3 h meeting for speech recognition (extrapolated from a 4 s clip), plus the chat model for AI correction.

## 11. Cost guards (already in the code; review them)
| Guard | Where | Default |
|---|---|---|
| Max upload size | `MAX_UPLOAD_BYTES` | 1 GiB |
| Max new recordings per 24 h | `MAX_JOBS_PER_DAY` | 30 |
| Audio deleted after | R2 lifecycle rule | 1 day |
| Access login required | `REQUIRE_ACCESS` (fail-closed) | on |
- [ ] Set a billing alert on your Alibaba/Qwen account and a usage notification in Cloudflare (Notifications) if offered.
- [ ] A **Retry** on a failed job resubmits it, which can cost again if Qwen had already processed it. It is not counted
  by `MAX_JOBS_PER_DAY`.

## Rollback and recovery
- Bad deploy: `npx wrangler deployments list`, then `npx wrangler rollback`.
- Back up the database: `npx wrangler d1 export transcribe-meeting --remote --output backup.sql`.
- Remove one recording and its files: use **Delete** in the list (also removes its audio and transcript from R2).

## Known limits to watch
- Free plan: 10 ms CPU per request (heavy work is deliberately in the browser), 50 subrequests per request
  (the Cron job checks at most 8 recordings per run), D1 and R2 free-tier quotas.
- Only one Qwen result format has been tested (the documented one). If a real result differs, the transcript page is
  the first thing to adjust (`src/shared/transcript.ts`).
- The signed Access login check was unit-tested with generated keys but not against a live Cloudflare team.
