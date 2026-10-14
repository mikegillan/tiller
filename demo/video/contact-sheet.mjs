// One frame per scene from the rendered cut, tiled 4 across: node contact-sheet.mjs <video.mp4> <sheet.png>
// Scenes are sampled in the middle of their first highlight, or of the scene when it has none.
import { execFileSync } from 'node:child_process';
import { BEATS, FPS } from './src/beats.js';

const [video, sheet] = process.argv.slice(2);
if (!video || !sheet) throw new Error('usage: node contact-sheet.mjs <video.mp4> <sheet.png>');

let start = 0;
const frames = BEATS.map((b) => {
  const h = b.highlights?.[0];
  const at = h ? (h.from + h.to) / 2 : b.seconds / 2;
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
