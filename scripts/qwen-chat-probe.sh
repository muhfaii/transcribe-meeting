#!/usr/bin/env bash
# Checks the chat endpoint + model used by the AI correction pass (both UNVERIFIED defaults).
#   DASHSCOPE_API_KEY=sk-... scripts/qwen-chat-probe.sh
# Env: QWEN_CHAT_URL (default <base>/compatible-mode/v1/chat/completions), QWEN_CHAT_MODEL (default qwen-plus),
#      DASHSCOPE_BASE_URL (default QwenCloud Singapore)
set -euo pipefail
: "${DASHSCOPE_API_KEY:?set DASHSCOPE_API_KEY}"
BASE="${DASHSCOPE_BASE_URL:-https://ap-southeast-1.maas.qwencloudapi.com}"
URL="${QWEN_CHAT_URL:-$BASE/compatible-mode/v1/chat/completions}"
MODEL="${QWEN_CHAT_MODEL:-qwen-plus}"
echo "POST $URL (model $MODEL)"
BODY="$(MODEL="$MODEL" python3 -c '
import json, os
print(json.dumps({"model": os.environ["MODEL"], "temperature": 0, "messages": [
  {"role": "system", "content": "Fix only clear ASR mistakes. Reply with JSON only: {\"items\":[{\"i\":0,\"text\":\"...\"}]}"},
  {"role": "user", "content": "Reference terms:\n- Kelyra\n\nTranscript items (JSON):\n[{\"i\":0,\"text\":\"Please send the report to Kellira before Friday.\"}]"}]}))')"
curl -sS -w "\nHTTP %{http_code}\n" -X POST "$URL" \
  -H "Authorization: Bearer $DASHSCOPE_API_KEY" -H "Content-Type: application/json" -d "$BODY"
echo "Expected: HTTP 200 and choices[0].message.content containing {\"items\":[{\"i\":0,\"text\":\"...Kelyra...\"}]}"
