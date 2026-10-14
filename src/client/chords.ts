// Chord state machine for the mux. Prefix Ctrl-\ then one key from BINDINGS, or 1-9 to jump to the nth node; Ctrl-\ twice sends a literal Ctrl-\.

const CHORD = '\x1c';

export type ActKey = 'new' | 'resume' | 'kill' | 'restart' | 'rename' | 'orch' | 'sidebar' | 'clear' | 'help';
export type Target = 'next' | 'prev' | 'needs' | 'back' | 'cur' | number;
export type Action =
  | { type: 'passthrough'; data: string } | { type: 'switch'; target: Target } | { type: 'echo'; data: string }
  | { type: 'picker' } | { type: 'detach' } | { type: 'act'; key: ActKey };
export interface ChordState { held: boolean; pick: string | null }
export const initial: ChordState = { held: false, pick: null };

/** Every chord key with its label; the mux help and the sidebar's action bar are derived from this. */
export const BINDINGS: Array<{ key: string; label: string; action: Action }> = [
  { key: 'n', label: 'new child', action: { type: 'act', key: 'new' } }, { key: 'e', label: 'rename', action: { type: 'act', key: 'rename' } },
  { key: 'x', label: 'kill', action: { type: 'act', key: 'kill' } }, { key: 'R', label: 'restart', action: { type: 'act', key: 'restart' } },
  { key: 'r', label: 'resume', action: { type: 'act', key: 'resume' } }, { key: 'c', label: 'clear exited', action: { type: 'act', key: 'clear' } },
  { key: 'o', label: 'new orchestrator here', action: { type: 'act', key: 'orch' } }, { key: 's', label: 'sidebar', action: { type: 'act', key: 'sidebar' } },
  { key: '?', label: 'help', action: { type: 'act', key: 'help' } }, { key: 'd', label: 'detach', action: { type: 'detach' } },
  { key: 'j', label: 'next', action: { type: 'switch', target: 'next' } }, { key: 'k', label: 'prev', action: { type: 'switch', target: 'prev' } },
  { key: '!', label: 'next needing you', action: { type: 'switch', target: 'needs' } }, { key: 'b', label: 'back', action: { type: 'switch', target: 'back' } },
  { key: 'l', label: 'jump by number', action: { type: 'picker' } },
];
const keys = Object.fromEntries(BINDINGS.map((b) => [b.key, b.action]));

/** The key help, word-wrapped to `w` columns. */
export function helpLines(w: number): string[] {
  const lines = ['tiller keys (Ctrl-\\ then):'];
  let line = '';
  for (const item of [...BINDINGS.map((b) => `${b.key} ${b.label}`), '1-9 jump to nth node']) {
    if (line && line.length + 3 + item.length > w) { lines.push(line); line = ''; }
    line += (line ? '   ' : ' ') + item;
  }
  return [...lines, line, ' Ctrl-\\ twice sends a literal Ctrl-\\; click a node or an action in the sidebar', ' (any key closes this)'];
}

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

