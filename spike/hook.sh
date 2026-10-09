#!/bin/sh
# orchestr8 hook: forward the Claude Code hook payload to the daemon. Never block, never print.
if [ -z "${O8_NODE_ID-}" ] || [ -z "${O8_ENDPOINT-}" ] || [ -z "${O8_TOKEN_FILE-}" ]; then
  cat >/dev/null 2>&1
  exit 0
fi
tok=$(cat "$O8_TOKEN_FILE" 2>/dev/null)
curl -s -o /dev/null --max-time 5 -X POST "$O8_ENDPOINT/hook" \
  -H "Authorization: Bearer $tok" -H "X-O8-Node: $O8_NODE_ID" \
  -H "Content-Type: application/json" --data-binary @- </dev/stdin >/dev/null 2>&1 &
exit 0
