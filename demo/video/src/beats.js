// The cut, beat by beat (demo-plan.md), tuned to capture run 3 in clips/. Plain data so node
// scripts can import it too.
export const FPS = 30;

// id matches the clip file prefix ("20" -> 20-tree.mp4). Optional per beat:
//   zoom: { origin, from = 1, to = 1.15 }: a slow zoom on the clip toward a transform-origin.
//         The capture is a 1920-wide CSS viewport, so text needs about 1.3x to be read.
//   segments: [{ from, to?, speed }] in source-clip seconds, to speed up waits inside a clip;
//             without it the whole clip plays at one automatic speed.
//   captionAt / captionSeconds: when the caption shows (default 0.6s in, for 4s)
const READ = 1.3;
export const BEATS = [
  { id: 'title', seconds: 4 },
  // The dialog is typed and sent in the first 5s; the rest is the orchestrator starting.
  { id: '10', seconds: 10, caption: 'You give one agent the task.', zoom: { origin: '0% 20%', to: READ } },
  {
    id: '20',
    seconds: 15,
    caption: 'It splits the work and spawns workers, each in its own git worktree.',
    // Workers appear from 3s to 10s; the orchestrator's summary lands at 15.5s and is held.
    segments: [{ from: 0, to: 3, speed: 2 }, { from: 3, to: 10, speed: 1 }, { from: 10, to: 15, speed: 2 }, { from: 15, speed: 1 }],
    zoom: { origin: '0% 0%', to: READ },
  },
  {
    id: '30',
    seconds: 9,
    caption: 'Rows show state, cost and the last message. Nothing to babysit.',
    zoom: { origin: '100% 0%', to: READ },
  },
  {
    id: '40',
    seconds: 12,
    caption: "Review a worker's branch in place and send comments back as its next message.",
    // The comment box opens at about 4s; the comment is sent and queued by about 13s.
    segments: [{ from: 0, to: 4, speed: 2 }, { from: 4, to: 11, speed: 1 }, { from: 11, speed: 2 }],
    zoom: { origin: '0% 0%', to: READ },
  },
  { id: '50', seconds: 9, caption: 'A reviewer node checks the work.', zoom: { origin: '0% 0%', to: READ } },
  // Played at 2x: the closed workers leave the tree in the first few seconds.
  { id: '55', seconds: 6, caption: 'The orchestrator merges and closes the workers.', zoom: { origin: '0% 0%', to: READ } },
  {
    id: '60',
    seconds: 8,
    caption: 'Closed nodes stay in history: read them, follow up or fork.',
    zoom: { origin: '0% 0%', to: READ },
  },
  { id: 'end', seconds: 5 },
];

export const isCard = (beat) => beat.id === 'title' || beat.id === 'end';
export const totalFrames = () => BEATS.reduce((n, b) => n + b.seconds * FPS, 0);

// Speed for a clip played whole: 1x if it is at most 1.5x too long (the end is trimmed), else
// the smallest whole multiple up to 4x that fits; anything still too long is trimmed at the end.
export const autoSpeed = (clipSeconds, targetSeconds) =>
  clipSeconds / targetSeconds <= 1.5 ? 1 : Math.min(4, Math.ceil(clipSeconds / targetSeconds));

// Lays a beat's clip onto its target length: [{ trimBefore, frames, speed }] in composition
// frames, back to back. Whatever the segments leave of the target is a freeze on the last frame.
export function planBeat(beat, clipSeconds) {
  const target = beat.seconds * FPS;
  const segments = beat.segments ?? [{ from: 0, speed: autoSpeed(clipSeconds, beat.seconds) }];
  const out = [];
  let used = 0;
  for (const s of segments) {
    const to = Math.min(s.to ?? clipSeconds, clipSeconds);
    const frames = Math.min(Math.round(((to - s.from) * FPS) / s.speed), target - used);
    if (frames <= 0) continue;
    out.push({ trimBefore: Math.round(s.from * FPS), frames, speed: s.speed });
    used += frames;
  }
  return out;
}
