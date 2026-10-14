#!/bin/sh
# Renders the cut to $DEMO_DIR/out/tiller-demo.mp4 plus a contact sheet, from the capture
# worker's clips in $DEMO_DIR/clips (CLIPS_DIR overrides).
set -eu
cd "$(dirname "$0")"
demo=${DEMO_DIR:-$HOME/.tiller/sessions/n-8f9599e6/demo}
clips=${CLIPS_DIR:-$demo/clips}
[ -f "$clips/clips.json" ] || { echo "no clips.json in $clips" >&2; exit 1; }

# public/ is generated: the brand assets and a link to the clips (Remotion's bundle forwards
# a linked directory).
mkdir -p public "$demo/out"
cp ../../docs/assets/logo-dark.png ../../src-tauri/icons/icon.png public/
ln -sfn "$clips" public/clips
npx remotion render src/index.jsx TillerDemo "$demo/out/tiller-demo.mp4" \
  --codec=h264 --enforce-audio-track --concurrency="${CONCURRENCY:-12}" --log=error
node contact-sheet.mjs "$demo/out/tiller-demo.mp4" "$demo/out/contact-sheet.png"
