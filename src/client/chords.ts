// Chord state machine shared by both attach clients. Prefix Ctrl-\ then one key: d detach, j/k next/prev node, ! next node needing you,
// b back, l picker, 1-9 jump, n new child, r resume, x kill, e rename, o new orchestrator, s sidebar, ? help, Ctrl-\ twice sends a literal Ctrl-\.

const CHORD = '\x1c';
export const HELP = 'Ctrl-\\ then: d detach, j/k next/prev, ! needs you, b back, 1-9 jump, n new child, r resume, x kill, e rename, o new root, s sidebar, Ctrl-\\ literal';

export type ActKey = 'new' | 'resume' | 'kill' | 'rename' | 'orch' | 'sidebar';
export type Target = 'next' | 'prev' | 'needs' | 'back' | 'cur' | number;
export type Action =
  | { type: 'passthrough'; data: string } | { type: 'switch'; target: Target } | { type: 'echo'; data: string }
  | { type: 'picker' } | { type: 'help' } | { type: 'detach' } | { type: 'act'; key: ActKey };
export interface ChordState { held: boolean; pick: string | null }
export const initial: ChordState = { held: false, pick: null };

const keys: Record<string, Action> = {
  d: { type: 'detach' }, j: { type: 'switch', target: 'next' }, k: { type: 'switch', target: 'prev' },
  n: { type: 'act', key: 'new' }, r: { type: 'act', key: 'resume' }, x: { type: 'act', key: 'kill' }, e: { type: 'act', key: 'rename' },
  o: { type: 'act', key: 'orch' }, s: { type: 'act', key: 'sidebar' },
  '!': { type: 'switch', target: 'needs' }, b: { type: 'switch', target: 'back' }, l: { type: 'picker' }, '?': { type: 'help' },
};

/** One input character through the chord machine. Switch indexes are zero-based. */
export function step(s: ChordState, b: string): { state: ChordState; actions: Action[] } {
  if (s.pick !== null) {
    if (/^\d$/.test(b)) return { state: { ...s, pick: s.pick + b }, actions: [{ type: 'echo', data: b }] };
    if (b === '\r' || b === '\n') {
      const n = parseInt(s.pick, 10);
      return { state: initial, actions: [{ type: 'switch', target: n >= 1 ? n - 1 : 'cur' }] };
    }
    return { state: b === '\x1b' ? initial : s, actions: b === '\x1b' ? [{ type: 'switch', target: 'cur' }] : [] };
  }
  if (!s.held) return b === CHORD ? { state: { ...s, held: true }, actions: [] } : { state: s, actions: [{ type: 'passthrough', data: b }] };
  const next = { ...s, held: false };
  if (b === 'l') return { state: { ...next, pick: '' }, actions: [{ type: 'picker' }] };
  if (/^[1-9]$/.test(b)) return { state: next, actions: [{ type: 'switch', target: Number(b) - 1 }] };
  return { state: next, actions: [keys[b] ?? { type: 'passthrough', data: b === CHORD ? CHORD : CHORD + b }] };
}

