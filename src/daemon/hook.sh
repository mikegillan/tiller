#!/bin/sh
# tiller hook: forward the Claude Code hook payload to the daemon. Never block, never print.
if [ -z "${TL_NODE_ID-}" ] || [ -z "${TL_ENDPOINT-}" ] || [ -z "${TL_TOKEN_FILE-}" ]; then
  cat >/dev/null 2>&1
  exit 0
fi
# The auth headers come from a 0600 file next to the token, so the token never appears on curl's argv.
curl -s -o /dev/null --max-time 5 -X POST "$TL_ENDPOINT/hook" \
  -H @"${TL_TOKEN_FILE%/*}/hook-headers" \
  -H "Content-Type: application/json" --data-binary @- </dev/stdin >/dev/null 2>&1 &
exit 0
