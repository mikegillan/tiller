// The cut, beat by beat (demo-plan.md). Plain data so node scripts can import it too.
export const FPS = 30;

// id matches the clip file prefix ("20" -> 20-tree.webm). Optional per beat:
//   zoom: transform-origin of a slow 1.0 -> 1.15 zoom on the clip
//   segments: [{ from, to?, speed }] in source-clip seconds, to speed up waits inside a clip;
//             without it the whole clip plays at one automatic speed.
//   captionAt / captionSeconds: when the caption shows (default 0.6s in, for 4s)
export const BEATS = [
  { id: 'title', seconds: 5 },
  { id: '10', seconds: 10, caption: 'You give one agent the task.' },
  { id: '20', seconds: 15, caption: 'It splits the work and spawns workers, each in its own git worktree.', zoom: '25% 35%' },
  { id: '30', seconds: 12, caption: 'Rows show state, cost and the last message. Nothing to babysit.' },
  { id: '40', seconds: 12, caption: "Review a worker's branch in place and send comments back as its next message.", zoom: '65% 45%' },
  { id: '50', seconds: 10, caption: 'A reviewer node checks the work; the orchestrator merges.' },
  { id: '60', seconds: 8, caption: 'Closed nodes stay in history: read them, follow up or fork.' },
  { id: 'end', seconds: 6 },
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
