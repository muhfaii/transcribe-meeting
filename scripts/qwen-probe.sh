#!/usr/bin/env bash
# Phase 0 probe: submit ONE short audio clip to the Qwen file-transcription API,
# wait for it, and print what the API really returns (parameters accepted, result
# fields, time units, speaker/language labels). Needs: bash, curl, python3.
#
#   DASHSCOPE_API_KEY=sk-... scripts/qwen-probe.sh <https-audio-url> [params.json] [context.json]
#
# Use a Singapore (ap-southeast-1) key from the PRIMARY workspace (hotwords are not
# supported in sub-workspaces). Keys are region-specific.
#
# <https-audio-url> must be reachable by Alibaba (e.g. a presigned R2 URL, see
# scripts/presign-get.mjs). Use a short, non-sensitive clip (1-3 min, 2+ speakers,
# ideally mixed Indonesian/English) — you pay per audio second.
#
# params.json is the "parameters" object. Default (from the docs):
#   {"channel_id": [0], "diarization_enabled": true, "language_hints": ["id", "en", "zh"]}
# Variants worth trying, one run each:
#   {"channel_id": [0], "diarization_enabled": true}                      # no language hint
#   {"channel_id": [0], "diarization_enabled": true, "language_hints": ["id", "en"]}
#   {"channel_id": [0], "diarization_enabled": true, "vocabulary": {"Budi": 4, "Qwen": 4}}   # instant hotwords
#
# context.json (optional) becomes input.context: a message array, max 5 turns and
# 400 characters of text per turn (extra is silently truncated), e.g.
#   [{"role":"user","content":[{"type":"input_text","text":"Weekly sync with Budi and Siti about the Jakarta rollout."}]}]
#
# Docs notes: diarization works on MONO audio and should stay within 2 HOURS of audio
# (longer may fail or time out) — test a long file separately if you need >2h.
#
# Env: DASHSCOPE_BASE_URL (default QwenCloud Singapore), QWEN_ASR_MODEL, POLL_SECONDS (10),
#      MAX_WAIT_SECONDS (1800), OUT_DIR (./probe-out)
set -euo pipefail

URL="${1:?usage: qwen-probe.sh <https-audio-url> [params.json]}"
PARAMS_FILE="${2:-}"
CONTEXT_FILE="${3:-}"
: "${DASHSCOPE_API_KEY:?set DASHSCOPE_API_KEY}"
BASE="${DASHSCOPE_BASE_URL:-https://ap-southeast-1.maas.qwencloudapi.com}"
MODEL="${QWEN_ASR_MODEL:-qwen-audio-3.1-asr-flash-filetrans}"
POLL="${POLL_SECONDS:-10}"
MAX_WAIT="${MAX_WAIT_SECONDS:-1800}"
OUT="${OUT_DIR:-./probe-out}"
mkdir -p "$OUT"

if [[ -n "$PARAMS_FILE" ]]; then PARAMS="$(cat "$PARAMS_FILE")"; else PARAMS='{"channel_id": [0], "diarization_enabled": true, "language_hints": ["id", "en", "zh"]}'; fi
if [[ -n "$CONTEXT_FILE" ]]; then CONTEXT="$(cat "$CONTEXT_FILE")"; else CONTEXT=''; fi

BODY="$(MODEL="$MODEL" URL="$URL" PARAMS="$PARAMS" CONTEXT="$CONTEXT" python3 - <<'PY'
import json, os
inp = {"file_urls": [os.environ["URL"]]}
if os.environ["CONTEXT"].strip():
    inp["context"] = json.loads(os.environ["CONTEXT"])
print(json.dumps({"model": os.environ["MODEL"], "input": inp,
                  "parameters": json.loads(os.environ["PARAMS"])}))
PY
)"
echo "== Request (audio URL hidden) =="
echo "$BODY" | python3 -c 'import sys,json; d=json.load(sys.stdin); d["input"]["file_urls"]=["<hidden>"]; print(json.dumps(d, indent=2))'

echo; echo "== Submit =="
SUBMIT="$(curl -sS -X POST "$BASE/api/v1/services/audio/asr/transcription" \
  -H "Authorization: Bearer $DASHSCOPE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-DashScope-Async: enable" \
  -d "$BODY")"
echo "$SUBMIT" | python3 -m json.tool 2>/dev/null || echo "$SUBMIT"
echo "$SUBMIT" > "$OUT/submit.json"

TASK_ID="$(echo "$SUBMIT" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("output",{}).get("task_id",""))
except Exception: print("")')"
[[ -n "$TASK_ID" ]] || { echo "No task_id returned — read the error above (wrong parameter name? bad key/region?)." >&2; exit 1; }
echo "task_id: $TASK_ID"

echo; echo "== Polling every ${POLL}s (max ${MAX_WAIT}s) =="
START=$SECONDS
while :; do
  RES="$(curl -sS "$BASE/api/v1/tasks/$TASK_ID" -H "Authorization: Bearer $DASHSCOPE_API_KEY")"
  STATUS="$(echo "$RES" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("output",{}).get("task_status","?"))
except Exception: print("?")')"
  echo "[$((SECONDS-START))s] $STATUS"
  case "$STATUS" in
    SUCCEEDED) break ;;
    FAILED|CANCELED|UNKNOWN) echo "$RES" | python3 -m json.tool; exit 2 ;;
  esac
  (( SECONDS-START > MAX_WAIT )) && { echo "Timed out; resume later with task_id $TASK_ID" >&2; exit 3; }
  sleep "$POLL"
done
echo "$RES" > "$OUT/task.json"
echo; echo "== Task response =="
echo "$RES" | python3 -m json.tool

echo; echo "== Downloading result file(s) =="
echo "$RES" | python3 -c 'import sys,json
for i,r in enumerate(json.load(sys.stdin).get("output",{}).get("results",[]) or []):
    u=r.get("transcription_url")
    if u: print(i, u)' | while read -r IDX RURL; do
  curl -sS "$RURL" -o "$OUT/result-$IDX.json"
  echo "saved $OUT/result-$IDX.json ($(wc -c < "$OUT/result-$IDX.json") bytes)"
  python3 - "$OUT/result-$IDX.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
print("\n== Result structure ==")
print("top-level keys:", list(doc.keys()))
props = doc.get("properties") or {}
print("properties:", json.dumps(props, ensure_ascii=False))
dur = props.get("original_duration_in_milliseconds")
ts = doc.get("transcripts") or []
print("transcripts:", len(ts))
for t in ts[:2]:
    print("  transcript keys:", list(t.keys()))
    sents = t.get("sentences") or []
    print("  sentences:", len(sents))
    if sents:
        print("  sentence keys:", sorted({k for s in sents for k in s}))
        for s in sents[:3]:
            print("   ", json.dumps(s, ensure_ascii=False)[:400])
        for key in sorted({k for s in sents for k in s}):
            vals = {json.dumps(s.get(key), ensure_ascii=False) for s in sents if key not in ("text", "words")}
            if key in ("text", "words"): continue
            if any(w in key.lower() for w in ("speaker", "lang", "emotion", "channel")):
                print(f"  distinct '{key}' values:", sorted(vals)[:20])
        for key in ("begin_time", "end_time", "start", "end"):
            nums = [s[key] for s in sents if isinstance(s.get(key), (int, float))]
            if nums: print(f"  {key}: min={min(nums)} max={max(nums)}" + (f"  (reported audio duration: {dur} ms)" if dur else ""))
    for k in t:
        if k not in ("sentences",): print(f"  {k}:", json.dumps(t[k], ensure_ascii=False)[:300])
PY
done
echo; echo "Done. Raw files are in $OUT/ — paste the 'Result structure' section back to Claude."
