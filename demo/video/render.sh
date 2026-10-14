#!/bin/sh
# Renders the cut to $DEMO/out/tiller-demo.mp4 plus a contact sheet.
# Uses the real clips in $DEMO/clips once their clips.json exists, else the placeholders
# (make-placeholders.sh). CLIPS_DIR overrides the choice.
set -eu
cd "$(dirname "$0")"
demo=${DEMO_DIR:-$HOME/.tiller/sessions/n-8f9599e6/demo}
clips=${CLIPS_DIR:-$demo/clips}
[ -f "$clips/clips.json" ] || clips=$demo/out/placeholder-clips
[ -f "$clips/clips.json" ] || { echo "no clips.json in $clips; run ./make-placeholders.sh" >&2; exit 1; }
echo "clips: $clips"

# public/ is generated: the brand assets and a link to the clips.
mkdir -p public "$demo/out"
cp ../../docs/assets/logo-dark.png ../../src-tauri/icons/icon.png public/
ln -sfn "$clips" public/clips

npx remotion render src/index.jsx TillerDemo "$demo/out/tiller-demo.mp4" \
  --codec=h264 --enforce-audio-track --concurrency="${CONCURRENCY:-12}" --log=error
node contact-sheet.mjs "$demo/out/tiller-demo.mp4" "$demo/out/contact-sheet.png"
