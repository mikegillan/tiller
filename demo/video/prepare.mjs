// Fills the generated public/ dir: brand assets, a link to the clips, and any beat cut from
// the full recording (cut once into <out>/cuts and reused). Usage: node prepare.mjs <clips> <out>
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { BEATS, cutFile } from './src/beats.js';

const [clips, out] = process.argv.slice(2);
if (!clips || !out) throw new Error('usage: node prepare.mjs <clips dir> <out dir>');

// Remotion's bundle copies public/ following directory links only, so both are linked whole.
mkdirSync('public', { recursive: true });
mkdirSync(join(out, 'cuts'), { recursive: true });
copyFileSync('../../docs/assets/logo-dark.png', 'public/logo-dark.png');
copyFileSync('../../src-tauri/icons/icon.png', 'public/icon.png');
rmSync('public/clips', { recursive: true, force: true });
symlinkSync(clips, 'public/clips');
rmSync('public/cuts', { recursive: true, force: true });
symlinkSync(join(out, 'cuts'), 'public/cuts');

const full = join(clips, 'full.webm');
for (const beat of BEATS.filter((b) => b.cut)) {
  const file = join(out, cutFile(beat));
  // Re-cut after a new capture; the times in beats.js must then be checked against it too.
  if (!existsSync(file) || statSync(file).mtimeMs < statSync(full).mtimeMs) {
    const { from, to } = beat.cut;
    console.log(`cutting ${from}-${to}s of full.webm to ${file}`);
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-ss', String(from), '-to', String(to), '-i', full,
      '-an', '-c:v', 'libx264', '-crf', '16', '-preset', 'fast', '-pix_fmt', 'yuv420p', file,
    ]);
  }
}
