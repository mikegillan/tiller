// `o8 attach <id>`: a tmux-like client. Prefix Ctrl-\ then one key: d detach, n/p next/prev node, ! next node needing you,
// b back, l picker, 1-9 jump, ? help, Ctrl-\ twice sends a literal Ctrl-\.
import { WebSocket } from 'ws';
import type { ClientMessage, NodeView, ServerMessage } from '../shared/protocol.js';

const CHORD = '\x1c';
export const HELP = 'Ctrl-\\ then: d detach, n/p next/prev, ! needs you, b back, l list, 1-9 jump, Ctrl-\\ literal';

export type Target = 'next' | 'prev' | 'needs' | 'back' | 'cur' | number;
export type Action =
  | { type: 'passthrough'; data: string } | { type: 'switch'; target: Target } | { type: 'echo'; data: string }
  | { type: 'picker' } | { type: 'help' } | { type: 'detach' };
export interface ChordState { held: boolean; pick: string | null }
export const initial: ChordState = { held: false, pick: null };

const keys: Record<string, Action> = {
  d: { type: 'detach' }, n: { type: 'switch', target: 'next' }, p: { type: 'switch', target: 'prev' },
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

const needsYou = (n: NodeView) => !n.status.exited && (n.status.state === 'blocked' || n.status.state === 'waiting');

export function attach(startId: string, { port, token }: { port: number; token: string }): Promise<number> {
  const { stdin, stdout } = process;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const send = (m: ClientMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
  const size = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
  const nodes = new Map<string, NodeView>();
  const bells = new Map<string, number>();
  let cur = startId, prev: string | null = null, cs = initial, raw = false, finished = false;

  /** Tree order: roots (or orphans) first, then each one's descendants depth-first. */
  const order = (): NodeView[] => {
    const out: NodeView[] = [];
    const walk = (pid: string | null) => {
      for (const n of nodes.values()) if ((n.parentId && nodes.has(n.parentId) ? n.parentId : null) === pid) { out.push(n); walk(n.id); }
    };
    walk(null);
    return out;
  };
  const notice = (s: string) => stdout.write(`\r\n[orchestr8] ${s}\r\n`);

  return new Promise((done) => {
    const finish = (msg: string, code: number) => {
      if (finished) return;
      finished = true;
      if (raw) stdin.setRawMode(false);
      raw = false;
      stdin.pause();
      stdin.off('data', onInput);
      stdout.off('resize', onResize);
      stdout.write(`\x1b[?25h\r\n${msg}\r\n`);
      ws.removeAllListeners('close');
      ws.close();
      done(code);
    };
    const show = (id: string) => {
      const n = nodes.get(id)!;
      cur = id;
      stdout.write(`\x1b[2J\x1b[H\x1b[7m[orchestr8] ${n.title} (${id.slice(0, 8)}) · ${n.status.state} · ${n.status.activity ?? ''} · Ctrl-\\ ? help\x1b[0m\r\n`);
      send({ t: 'select', id });
      send({ t: 'attach', id, ...size() });
    };
    const switchTo = (id: string) => {
      send({ t: 'detach', id: cur }); // switching to the same node is a redraw: re-attach replays scrollback
      if (id !== cur) prev = cur;
      show(id);
    };
    const pick = (t: Target) => {
      const list = order(), i = list.findIndex((n) => n.id === cur), len = list.length;
      let n: NodeView | undefined;
      if (t === 'cur') n = nodes.get(cur);
      else if (t === 'back') n = prev ? nodes.get(prev) : undefined;
      else if (typeof t === 'number') n = list[t];
      else if (t === 'needs') n = [...list.slice(i + 1), ...list.slice(0, i)].find(needsYou);
      else n = list[(i + (t === 'next' ? 1 : len - 1)) % len];
      if (n) switchTo(n.id);
      else notice(t === 'needs' ? 'no node needs you' : 'no such node');
    };
    const run = (a: Action) => {
      if (a.type === 'passthrough') send({ t: 'input', id: cur, data: a.data });
      else if (a.type === 'detach') finish('[detached]', 0);
      else if (a.type === 'switch') pick(a.target);
      else if (a.type === 'echo') stdout.write(a.data);
      else if (a.type === 'help') notice(HELP);
      else {
        stdout.write('\x1b[2J\x1b[H[orchestr8] pick a node, Enter to switch, Esc to cancel\r\n');
        order().forEach((n, i) => stdout.write(`${n.id === cur ? '*' : ' '}${i + 1}. ${n.id.slice(0, 8)} ${n.status.state.padEnd(8)} ${n.title} ${(n.status.activity ?? '').slice(0, 50)}${needsYou(n) ? ' !' : ''}\r\n`));
        stdout.write('> ');
      }
    };
    const onInput = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        const r = step(cs, ch);
        cs = r.state;
        r.actions.forEach(run);
      }
    };
    const onResize = () => send({ t: 'resize', id: cur, ...size() });

    ws.on('open', () => send({ t: 'auth', token }));
    ws.on('error', (e) => finish(`cannot reach daemon: ${e.message}`, 1));
    ws.on('close', () => finish('[connection closed]', 1));
    ws.on('message', (raw_) => {
      const m = JSON.parse(raw_.toString()) as ServerMessage;
      if (m.t === 'snapshot') {
        for (const n of m.nodes) nodes.set(n.id, n);
        if (!nodes.has(cur)) return finish(`no such node: ${cur}`, 1);
        show(cur);
        stdin.setRawMode(true);
        raw = true;
        stdin.resume();
        stdin.on('data', onInput);
        stdout.on('resize', onResize);
      } else if (m.t === 'data') { if (m.id === cur && cs.pick === null) stdout.write(m.data); }
      else if (m.t === 'node') {
        const was = nodes.get(m.node.id);
        nodes.set(m.node.id, m.node);
        const now = Date.now();
        if (m.node.id !== cur && needsYou(m.node) && !(was && needsYou(was)) && now - (bells.get(m.node.id) ?? 0) >= 5000) {
          bells.set(m.node.id, now);
          stdout.write('\x07');
        }
      } else if (m.t === 'removed') {
        nodes.delete(m.id);
        if (prev === m.id) prev = null;
        if (m.id !== cur) return;
        const next = order()[0];
        if (next) { cs = initial; show(next.id); } else finish('[node removed]', 0);
      } else if (m.t === 'focus') { if (m.from === cur && nodes.has(m.id)) switchTo(m.id); }
      else if (m.t === 'error' && m.id === cur) finish(m.message, 1);
    });
  });
}
