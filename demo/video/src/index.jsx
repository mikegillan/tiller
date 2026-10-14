import { Composition, registerRoot, staticFile } from 'remotion';
import { BEATS, FPS, isCard, totalFrames } from './beats.js';
import { Demo } from './Demo.jsx';

// clips.json is written by the capture worker: { clips: [{ beat, file, durationMs, notes }] }.
// A clip belongs to the beat whose id prefixes its file name (20-tree.mp4 -> beat "20").
const loadClips = async () => {
  const res = await fetch(staticFile('clips/clips.json'));
  if (!res.ok) throw new Error(`public/clips/clips.json: HTTP ${res.status}; render.sh links public/clips`);
  const json = await res.json();
  const list = Array.isArray(json) ? json : json.clips;
  const clips = {};
  for (const beat of BEATS.filter((b) => !isCard(b))) {
    const clip = list.find((c) => c.file.startsWith(`${beat.id}-`));
    if (!clip) throw new Error(`clips.json has no clip for beat ${beat.id}`);
    clips[beat.id] = { src: staticFile(`clips/${clip.file}`), seconds: clip.durationMs / 1000 };
  }
  return { props: { clips } };
};

registerRoot(() => (
  <Composition
    id="TillerDemo"
    component={Demo}
    width={1920}
    height={1080}
    fps={FPS}
    durationInFrames={totalFrames()}
    defaultProps={{ clips: {} }}
    calculateMetadata={loadClips}
  />
));
