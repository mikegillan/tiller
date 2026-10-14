#!/bin/sh
# Renders the cut to $DEMO_DIR/out/tiller-demo.mp4 plus a contact sheet, from the capture
# worker's clips in $DEMO_DIR/clips (CLIPS_DIR overrides).
set -eu
cd "$(dirname "$0")"
demo=${DEMO_DIR:-$HOME/.tiller/sessions/n-8f9599e6/demo}
clips=${CLIPS_DIR:-$demo/clips}
[ -f "$clips/clips.json" ] || { echo "no clips.json in $clips" >&2; exit 1; }

mkdir -p "$demo/out"
node prepare.mjs "$clips" "$demo/out"
npx remotion render src/index.jsx TillerDemo "$demo/out/tiller-demo.mp4" \
  --codec=h264 --enforce-audio-track --concurrency="${CONCURRENCY:-12}" --log=error
node contact-sheet.mjs "$demo/out/tiller-demo.mp4" "$demo/out/contact-sheet.png"
