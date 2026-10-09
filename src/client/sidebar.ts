// The sidebar: a rounded frame holding the whole tree (3 lines per node), an action bar for the selected node, and daemon status.
// Layout is pure: model in, styled lines and click targets out.
import type { NodeView } from '../shared/protocol.js';
import { shortEffort, shortModel } from '../shared/format.js';

export type Seg = [sgr: string, text: string];
export const needsYou = (n: NodeView) => !n.status.exited && (n.status.state === 'blocked' || n.status.state === 'waiting');

export interface TreeItem { n: NodeView; head: string; cont: string }
/** Tree order (roots, then each one's descendants depth-first) with the connector text for each node's first line and its continuation lines. */
export function tree(nodes: Map<string, NodeView>): TreeItem[] {
  const out: TreeItem[] = [];
  const walk = (pid: string | null, guides: string, root: boolean) => {
    const ks = [...nodes.values()].filter((n) => (n.parentId && nodes.has(n.parentId) ? n.parentId : null) === pid);
    ks.forEach((n, i) => {
      const last = i === ks.length - 1, g = last ? '   ' : '│  ';
      out.push(root ? { n, head: '', cont: '  ' } : { n, head: guides + (last ? '└─ ' : '├─ '), cont: guides + g + '  ' });
      walk(n.id, root ? '' : guides + g, false);
    });
  };
  walk(null, '', true);
  return out;
}

const len = (segs: Seg[]) => segs.reduce((a, s) => a + s[1].length, 0);
/** Cut to `w` cells, ending in a dim ellipsis when something was dropped. */
function cut(segs: Seg[], w: number): Seg[] {
  if (len(segs) <= w) return segs;
  const out: Seg[] = [];
  let room = Math.max(0, w - 1);
  for (const [s, t] of segs) { if (room <= 0) break; out.push([s, t.slice(0, room)]); room -= t.length; }
  return [...out, ['2', '…']];
}
/** One line exactly `w` cells wide; `bg` (an SGR background) covers all of it, padding included. */
export function paint(segs: Seg[], w: number, bg = ''): string {
  const cs = cut(segs, w);
  return [...cs, ['', ' '.repeat(Math.max(0, w - len(cs)))] as Seg].map(([s, t]) => `\x1b[0${bg && ';' + bg}${s && ';' + s}m${t}`).join('') + '\x1b[0m';
}
const lr = (left: Seg[], right: string, w: number): Seg[] => {
  const l = cut(left, w - right.length - 1);
  return [...l, ['', ' '.repeat(Math.max(1, w - len(l) - right.length))], ['2', right]];
};

const glyph = (n: NodeView): Seg =>
  n.status.exited ? ['2', '○'] : n.status.errored ? ['31', '✗'] :
  ({ working: ['36', '●'], blocked: ['33', '!'], waiting: ['33', '!'], done: ['32', '✓'] } as Record<string, Seg>)[n.status.state] ?? ['2', '·'];

export const age = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };
const k = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);

/** `opus 5.5 · high · ctx 42% (84k/200k) $0.42`; as the width shrinks, effort, token counts and cost go first. */
export function meta(n: NodeView, w: number): Seg[] {
  const s = n.status, pct = s.contextPct;
  const model = shortModel(s.model ?? n.model), effort = s.effort ? shortEffort(s.effort) : '';
  const ctxColor = pct === undefined ? '' : pct < 50 ? '32' : pct <= 80 ? '33' : '31';
  const build = (full: boolean, withEffort: boolean): Seg[] => {
    const segs: Seg[] = [];
    const add = (x: Seg) => { if (segs.length) segs.push(['2', ' · ']); segs.push(x); };
    if (model) add(['2', model]);
    if (withEffort && effort) add(['2', effort]);
    if (pct !== undefined) {
      add([ctxColor, `ctx ${Math.round(pct)}%${full && s.contextTokens && s.contextWindow ? ` (${k(s.contextTokens)}/${k(s.contextWindow)})` : ''}`]);
      if (full && s.costUsd !== undefined) segs.push(['2', ` $${s.costUsd.toFixed(2)}`]);
    }
    return segs;
  };
  const tries = [build(true, true), build(false, true), build(false, false)];
  return tries.find((t) => len(t) <= w) ?? tries[2]!;
}

export const ACTIONS: Array<{ key: string; label: string; act: string }> = [
  { key: 'n', label: 'new child', act: 'new' }, { key: 'e', label: 'rename', act: 'rename' }, { key: 'x', label: 'kill', act: 'kill' },
  { key: 'r', label: 'resume', act: 'resume' }, { key: 'o', label: 'new orchestrator here', act: 'orch' },
  { key: 's', label: 'hide', act: 'sidebar' }, { key: '?', label: 'help', act: 'help' },
];

export interface SideModel {
  nodes: Map<string, NodeView>; cur: string; scroll: number; now: number;
  port: number; connected: boolean; /** One-line input or confirmation shown in the footer. */ prompt?: string; notice?: string;
}
export interface SideLayout {
  lines: string[];
  /** Node id under each 0-based screen row. */
  nodeAt: Array<string | undefined>;
  /** Clickable actions, columns 1-based within the sidebar. */
  acts: Array<{ row: number; x0: number; x1: number; act: string }>;
  /** Items scroll..scroll+shown-1 are on screen. */
  shown: number;
}

const BG = '48;5;236';
export function layoutSidebar(m: SideModel, W: number, H: number): SideLayout {
  const w = W - 2, B = '\x1b[2m';
  const cur = m.nodes.get(m.cur);
  const frame = (inner: string) => `${B}│\x1b[0m${inner}${B}│\x1b[0m`;
  const rule = (l: string, r: string) => `${B}${l}${'─'.repeat(w)}${r}\x1b[0m`;
  const count = ` ${m.nodes.size} `;
  const top = paint([['2', '╭─ '], ['1', 'orchestr8'], ['2', count + '─'.repeat(Math.max(0, W - 13 - count.length)) + '╮']], W);

  // Bottom block: actions, divider, status, keys / prompt.
  const items = ACTIONS.filter((a) => a.act !== 'resume' || cur?.status.exited);
  const actRows: Seg[][] = [[]];
  const acts: SideLayout['acts'] = [];
  for (const a of items) {
    const text = `[${a.key}] ${a.label}`;
    let row = actRows.at(-1)!;
    if (len(row) && len(row) + 2 + text.length > w) actRows.push((row = []));
    if (len(row)) row.push(['', '  ']);
    const x0 = len(row) + 2;
    row.push(['2', `[${a.key}]`], ['', text.slice(3)]);
    acts.push({ row: actRows.length - 1, x0, x1: Math.min(w + 1, x0 + text.length - 1), act: a.act });
  }
  const status: Seg[] = m.connected ? [['32', '●'], ['', ` daemon ${m.port}`]] : [['31', '●'], ['', ' reconnecting…']];
  const footer: Seg[] = m.prompt !== undefined ? [['36', m.prompt + '▏']] : [['2', m.notice ?? '^\\ n new · d detach · ? help']];
  const bottom = [rule('├', '┤'), ...actRows.map((r) => frame(paint(r, w))), rule('├', '┤'), frame(paint(status, w)), frame(paint(footer, w)), rule('╰', '╯')];

  const lines = [top], nodeAt: SideLayout['nodeAt'] = [undefined];
  const area = Math.max(0, H - 1 - bottom.length);
  const items3 = tree(m.nodes);
  let shown = 0;
  for (const { n, head, cont } of items3.slice(m.scroll)) {
    const sel = n.id === m.cur, bg = sel ? BG : '';
    const rows: Seg[][] = [lr([['2', head], glyph(n), ['', ' '], [sel || needsYou(n) ? '1' : '', n.title], ...(n.unread ? [['36', ' •'] as Seg] : [])], age(m.now - n.status.changedAt), w)];
    const act = n.status.activity;
    if (act) rows.push([['2', cont], [n.status.state === 'blocked' ? '33' : '2', act]]);
    const mt = meta(n, w - cont.length);
    if (mt.length) rows.push([['2', cont], ...mt]);
    if (lines.length - 1 + rows.length > area) break;
    for (const r of rows) { lines.push(frame(paint(r, w, bg))); nodeAt.push(n.id); }
    shown++;
  }
  while (lines.length < H - bottom.length) { lines.push(frame(' '.repeat(w))); nodeAt.push(undefined); }
  const first = lines.length;
  lines.push(...bottom);
  return { lines: lines.slice(0, H), nodeAt, shown, acts: acts.map((a) => ({ ...a, row: first + 1 + a.row, x0: a.x0 + 1, x1: a.x1 + 1 })) };
}
