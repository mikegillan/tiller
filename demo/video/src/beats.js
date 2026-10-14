// The cut, beat by beat (demo-plan.md), tuned to the capture in clips/. Plain data so node
// scripts can import it too.
export const FPS = 30;

// id matches the clip file prefix ("20" -> 20-tree.mp4). Optional per beat:
//   cut: { from, to } seconds of the full recording (full.webm) to use instead of a beat clip;
//        prepare.mjs cuts it out once.
//   zoom: { origin, from = 1, to = 1.15 }: a slow zoom on the clip toward a transform-origin
//   segments: [{ from, to?, speed }] in source-clip seconds, to speed up waits inside a clip;
//             without it the whole clip plays at one automatic speed.
//   captionAt / captionSeconds: when the caption shows (default 0.6s in, for 4s)
export const BEATS = [
  { id: 'title', seconds: 4 },
  { id: '10', seconds: 10, caption: 'You give one agent the task.' },
  {
    id: '20',
    seconds: 14,
    caption: 'It splits the work and spawns workers, each in its own git worktree.',
    // The orchestrator reads the repo for the first 4.5s.
    segments: [{ from: 0, to: 4.5, speed: 2 }, { from: 4.5, speed: 1 }],
    zoom: { origin: '0% 12%', to: 1.3 },
  },
  {
    id: '30',
    seconds: 9,
    caption: 'Rows show state, cost and the last message. Nothing to babysit.',
    zoom: { origin: '100% 15%', to: 1.35 },
  },
  {
    id: '40',
    seconds: 11,
    caption: "Review a worker's branch in place and send comments back as its next message.",
    // The diff loads in the first second; the comment is typed from about 5s.
    segments: [{ from: 1, to: 5, speed: 2 }, { from: 5, speed: 1 }],
    zoom: { origin: '45% 25%', to: 1.3 },
  },
  {
    id: '50',
    seconds: 11,
    caption: 'A reviewer node checks the work.',
    // No beat clip: the reviewer arrived after the capture script stopped waiting. Its row
    // appears at about 1005s and reports at about 1068s. The main pane is the orchestrator's
    // log, so this stays cropped on the sidebar.
    cut: { from: 1005, to: 1071 },
    segments: [{ from: 0, speed: 6 }],
    zoom: { origin: '0% 0%', from: 2, to: 2.1 },
  },
  {
    id: '55',
    seconds: 6,
    caption: 'The orchestrator merges and closes the workers.',
    zoom: { origin: '0% 0%', to: 1.25 },
  },
  {
    id: '60',
    seconds: 8,
    caption: 'Closed nodes stay in history: read them, follow up or fork.',
    zoom: { origin: '0% 10%', to: 1.2 },
  },
  { id: 'end', seconds: 5 },
];

export const isCard = (beat) => beat.id === 'title' || beat.id === 'end';
export const totalFrames = () => BEATS.reduce((n, b) => n + b.seconds * FPS, 0);
export const cutFile = (beat) => `cuts/${beat.id}-cut.mp4`;

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
