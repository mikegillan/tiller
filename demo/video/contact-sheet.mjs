// One frame per scene from the rendered cut, tiled 4 across: node contact-sheet.mjs <video.mp4> <sheet.png>
// Clip scenes are sampled mid-caption so the sheet shows the wording too.
import { execFileSync } from 'node:child_process';
import { BEATS, FPS, isCard } from './src/beats.js';

const [video, sheet] = process.argv.slice(2);
if (!video || !sheet) throw new Error('usage: node contact-sheet.mjs <video.mp4> <sheet.png>');

let start = 0;
const frames = BEATS.map((b) => {
  const at = isCard(b) ? b.seconds / 2 : (b.captionAt ?? 0.6) + (b.captionSeconds ?? 4) / 2;
  const frame = start + Math.round(at * FPS);
  start += b.seconds * FPS;
  return frame;
});

const select = frames.map((n) => `eq(n\\,${n})`).join('+');
const rows = Math.ceil(frames.length / 4);
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error', '-i', video,
  '-vf', `select='${select}',scale=480:270,tile=4x${rows}:padding=8:margin=8:color=0x0f0e14`,
  '-fps_mode', 'passthrough', '-frames:v', '1', sheet,
]);
console.log(`contact sheet: ${sheet} (frames ${frames.join(', ')})`);
