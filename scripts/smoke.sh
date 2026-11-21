#!/usr/bin/env bash
# Post-deploy smoke test (no Qwen spend: nothing is transcribed).
#   scripts/smoke.sh https://transcribe.example.com
# With Cloudflare Access in front, create a service token (Zero Trust → Access → Service auth), add a
# "Service Auth" allow policy to the app, and export:
#   CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=…
# Local dev: SMOKE_LOCAL=1 scripts/smoke.sh http://localhost:8787   (skips the "is the API protected" checks)
set -uo pipefail
BASE="${1:?usage: smoke.sh <base-url>}"; BASE="${BASE%/}"
FAIL=0
ok()   { echo "  ok    $*"; }
bad()  { echo "  FAIL  $*"; FAIL=1; }
warn() { echo "  warn  $*"; }

AUTH=()
if [[ -n "${CF_ACCESS_CLIENT_ID:-}" && -n "${CF_ACCESS_CLIENT_SECRET:-}" ]]; then
  AUTH=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
fi
req() { curl -sS -m 30 -o /tmp/smoke-body.$$ -w "%{http_code}" "${AUTH[@]}" "$@"; }
body() { cat /tmp/smoke-body.$$; }
trap 'rm -f /tmp/smoke-body.$$' EXIT

echo "1. Protection"
if [[ "${SMOKE_LOCAL:-0}" == "1" ]]; then
  warn "SMOKE_LOCAL=1: skipping the unauthenticated-access check"
else
  code="$(curl -sS -m 30 -o /dev/null -w '%{http_code}' "$BASE/api/jobs")"
  case "$code" in 301|302|303|307|401|403) ok "unauthenticated /api/jobs is refused ($code)";;
                  *) bad "unauthenticated /api/jobs returned $code — the API is OPEN; check Access / REQUIRE_ACCESS";; esac
fi

echo "2. App and database"
code="$(req "$BASE/")"
if [[ "$code" == "200" ]] && body | grep -q "Meeting Transcriber"; then ok "page loads"; else bad "page returned $code (is Access blocking the service token?)"; fi
code="$(req "$BASE/api/jobs")"
if [[ "$code" == "200" ]] && body | grep -q '"jobs"'; then ok "D1 reachable, /api/jobs OK"; else bad "/api/jobs returned $code: $(body | head -c 200)"; fi
code="$(req "$BASE/api/glossary")"
if [[ "$code" == "200" ]] && body | grep -q '"terms"'; then ok "/api/glossary OK"; else bad "/api/glossary returned $code: $(body | head -c 200)"; fi

echo "3. Uploads (R2 binding + signing)"
code="$(req -X POST "$BASE/api/uploads" -H 'content-type: application/json' -d '{"fileName":"a.mp4","size":1000,"contentType":"video/mp4"}')"
[[ "$code" == "400" ]] && ok "non-m4a is rejected" || bad "mp4 upload returned $code (expected 400)"
code="$(req -X POST "$BASE/api/uploads" -H 'content-type: application/json' -d '{"fileName":"smoke.m4a","size":1000,"contentType":"audio/x-m4a"}')"
if [[ "$code" == "200" ]]; then
  KEY="$(body | python3 -c 'import sys,json;print(json.load(sys.stdin)["key"])')"
  UPID="$(body | python3 -c 'import sys,json;print(json.load(sys.stdin)["uploadId"])')"
  ok "multipart upload created (R2 binding works)"
  code="$(req -X POST "$BASE/api/uploads/sign" -H 'content-type: application/json' -d "{\"key\":\"$KEY\",\"uploadId\":\"$UPID\",\"partNumbers\":[1]}")"
  URL="$(body | python3 -c 'import sys,json;print(json.load(sys.stdin)["parts"][0]["url"])' 2>/dev/null)"
  if [[ "$URL" == *"X-Amz-Signature="* && "$URL" == *"r2.cloudflarestorage.com"* ]]; then ok "presigned R2 part URL issued (R2 secrets are set)"
  elif [[ "${SMOKE_LOCAL:-0}" == "1" ]]; then warn "local fallback upload URL in use"
  else bad "no presigned R2 URL — set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY (got: ${URL:0:60})"; fi
  req -X POST "$BASE/api/uploads/abort" -H 'content-type: application/json' -d "{\"key\":\"$KEY\",\"uploadId\":\"$UPID\"}" >/dev/null && ok "test upload aborted (nothing left behind)"
else
  bad "creating an upload returned $code: $(body | head -c 200)"
fi

echo
if [[ $FAIL -eq 0 ]]; then echo "Smoke test passed."; else echo "Smoke test FAILED."; fi
echo "Not covered here: the Cron job and the Qwen calls. Check them with a real short recording (DEPLOY.md, step 10)."
exit $FAIL
