#!/bin/sh
# Stand-in clips (a labelled dark frame with a moving bar, so speed-ups are visible) and a
# clips.json in the capture worker's format, so the cut renders before the real capture exists.
set -eu
cd "$(dirname "$0")"
dir=${1:-$HOME/.tiller/sessions/n-8f9599e6/demo/out/placeholder-clips}
mkdir -p "$dir"

json=""
# name:seconds. Lengths are deliberately uneven to exercise the speed-up and the hold.
for spec in 10-task:12 20-tree:40 30-watch:14 40-diff:12 50-merge:22 60-history:5; do
  name=${spec%:*}
  secs=${spec#*:}
  npx remotion still src/index.jsx Placeholder "$dir/$name.png" --props="{\"label\":\"$name\"}" --log=error
  ffmpeg -y -loglevel error -loop 1 -framerate 30 -t "$secs" -i "$dir/$name.png" \
    -f lavfi -i color=c=0xa78bfa:s=160x16:r=30 \
    -filter_complex "[0][1]overlay=x='mod(t*240,1760)':y=1000:shortest=1,format=yuv420p" \
    -c:v libvpx -b:v 1M -deadline realtime -cpu-used 8 "$dir/$name.webm"
  rm "$dir/$name.png"
  json="$json${json:+,}{\"beat\":\"$name\",\"file\":\"$name.webm\",\"durationMs\":$((secs * 1000)),\"notes\":\"placeholder\"}"
done
echo "[$json]" >"$dir/clips.json"
echo "placeholders in $dir"
