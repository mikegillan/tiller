// The sidebar: a rounded frame holding the whole tree (3 lines per node), an action bar for the selected node, and daemon status.
// Layout is pure: model in, styled lines and click targets out.
import { needsYou, type NodeView, type Usage } from '../shared/protocol.js';
import { ctxLevel, fmtAge, fmtTokens, outcomeLine, shortEffort, shortModel, usageParts } from '../shared/format.js';
import { fmtUsd, subtreeSpend, todaySpend } from '../shared/spend.js';
import { treeOrder } from '../shared/tree.js';
import { BINDINGS } from './chords.js';

type Seg = [sgr: string, text: string];

interface TreeItem { n: NodeView; head: string; cont: string }
/** Tree order (roots, then each one's descendants depth-first) with the connector text for each node's first line and its continuation lines. */
export function tree(nodes: Map<string, NodeView>): TreeItem[] {
  return treeOrder(nodes.values()).map(({ node: n, depth, lasts }) => {
    if (depth === 0) return { n, head: '', cont: '  ' };
    const guides = lasts.slice(1, -1).map((l) => (l ? '   ' : '│  ')).join(''), last = lasts.at(-1);
    return { n, head: guides + (last ? '└─ ' : '├─ '), cont: guides + (last ? '   ' : '│  ') + '  ' };
  });
}

// prune: wide = the main East Asian and emoji blocks; no combining marks or ZWJ sequences. Use a full wcwidth table if titles need them.
const wide = (c: number) => (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
  || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd);
const control = (c: number) => c < 0x20 || (c >= 0x7f && c <= 0x9f);
/** Terminal cells for `t`: one per code point, two for a wide one, none for a control character (paint strips those). */
const cells = (t: string) => { let n = 0; for (const ch of t) { const c = ch.codePointAt(0)!; n += control(c) ? 0 : wide(c) ? 2 : 1; } return n; };
const len = (segs: Seg[]) => segs.reduce((a, s) => a + cells(s[1]), 0);
/** Cut to `w` cells, ending in a dim ellipsis when something was dropped. */
function cut(segs: Seg[], w: number): Seg[] {
  if (len(segs) <= w) return segs;
  const out: Seg[] = [];
  let room = Math.max(0, w - 1);
  for (const [s, t] of segs) {
    let kept = '';
    for (const ch of t) { if (cells(ch) > room) { room = 0; break; } kept += ch; room -= cells(ch); }
    out.push([s, kept]);
    if (room <= 0) break;
  }
  return [...out, ['2', '…']];
}
// C0 and C1 controls: titles, activity and notices are agent- or daemon-supplied and must not reach the real terminal as escapes.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
export const stripControl = (t: string) => t.replace(CONTROL, '');
/** One line exactly `w` cells wide; `bg` (an SGR background) covers all of it, padding included. */
function paint(segs: Seg[], w: number, bg = ''): string {
  const cs = cut(segs.map(([s, t]) => [s, stripControl(t)]), w);
  return [...cs, ['', ' '.repeat(Math.max(0, w - len(cs)))] as Seg].map(([s, t]) => `\x1b[0${bg && ';' + bg}${s && ';' + s}m${t}`).join('') + '\x1b[0m';
}
const lr = (left: Seg[], right: string, w: number): Seg[] => {
  const l = cut(left, w - right.length - 1);
  return [...l, ['', ' '.repeat(Math.max(1, w - len(l) - right.length))], ['2', right]];
};

const glyph = (n: NodeView): Seg =>
  n.status.exited ? ['2', '○'] : n.status.errored ? ['31', '✗'] :
  ({ working: ['36', '●'], blocked: ['33', '!'], waiting: ['33', '!'], done: ['32', '✓'], armed: ['36', '◇'], queued: ['36', '…'] } as Record<string, Seg>)[n.status.state] ?? ['2', '·'];


/**
 * `⎇ n-3f2a ↑1●2 · opus 5.5 · high · ctx 42% (84k/200k) $0.42 Σ$3.10` (↑ commits ahead of base, ● uncommitted files, or
 * "merged"; Σ: spend with descendants, `subtree`); as the width shrinks, the branch goes first, then token counts and cost, then effort.
 */
export function meta(n: NodeView, w: number, subtree = n.spentUsd ?? 0): Seg[] {
  const s = n.status, pct = s.contextPct, own = n.spentUsd ?? 0, g = s.git;
  const spend = subtree > 0 || n.spentUsd !== undefined ? fmtUsd(own) + (subtree > own ? ` Σ${fmtUsd(subtree)}` : '') : '';
  const model = shortModel(s.model ?? n.model), effort = s.effort ? shortEffort(s.effort) : '';
  const ctxColor = pct === undefined ? '' : { ok: '32', warn: '33', bad: '31' }[ctxLevel(pct)];
  const wt = n.worktree;
  const counts = `${g?.ahead ? `↑${g.ahead}` : ''}${g?.dirty ? `●${g.dirty}` : ''}`;
  const branch = wt && [`⎇ ${wt.branch.split('/').pop()!.slice(0, 6)}`, counts, g?.mergedAt && 'merged'].filter(Boolean).join(' ');
  const build = (full: boolean, withEffort: boolean, withBranch = false): Seg[] => {
    const segs: Seg[] = [];
    const add = (x: Seg) => { if (segs.length) segs.push(['2', ' · ']); segs.push(x); };
    if (withBranch && branch) add([wt?.missing ? '33' : '2', branch]);
    if (model) add(['2', model]);
    if (withEffort && effort) add(['2', effort]);
    if (pct !== undefined) {
      add([ctxColor, `ctx ${Math.round(pct)}%${full && s.contextTokens && s.contextWindow ? ` (${fmtTokens(s.contextTokens)}/${fmtTokens(s.contextWindow)})` : ''}`]);
    }
    if (full && spend) { if (pct !== undefined) segs.push(['2', ` ${spend}`]); else add(['2', spend]); }
    return segs;
  };
  const tries = [build(true, true, true), build(true, true), build(false, true), build(false, false)];
  return tries.find((t) => len(t) <= w) ?? tries[3]!;
}

const ACTIONS = BINDINGS.flatMap(({ key, label, action: a }) => (a.type === 'act' ? [{ key, label, act: a.key }] : []));

/** The first visible item index such that item `i` is fully on screen, starting from `scroll` and moving only as far as needed. */
export function revealScroll(m: SideModel, W: number, H: number, i: number): number {
  const id = tree(m.nodes)[i]!.n.id;
  let s = Math.min(m.scroll, i);
  while (s < i && !layoutSidebar({ ...m, scroll: s }, W, H).nodeAt.includes(id)) s++;
  return s;
}

export interface SideModel {
  nodes: Map<string, NodeView>; cur: string; scroll: number; now: number;
  port: number; connected: boolean; /** One-line input or confirmation shown in the footer. */ prompt?: string; notice?: string;
  /** Account-level rate limits, shown compactly on the status row. */ usage?: Usage;
}
export interface SideLayout {
  lines: string[];
  /** Node id under each 0-based screen row. */
  nodeAt: Array<string | undefined>;
  /** Clickable actions, columns 1-based within the sidebar. */
  acts: Array<{ row: number; x0: number; x1: number; act: string }>;
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
  const root = cur?.parentId === null; // an orchestrator is restarted, never killed
  const items = ACTIONS.filter((a) => (a.act !== 'resume' || cur?.status.exited) && (a.act !== 'kill' || !root) && (a.act !== 'restart' || root));
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
  const today = todaySpend(m.nodes.values(), m.now);
  const queued = [...m.nodes.values()].filter((n) => n.status.state === 'queued').length;
  const status: Seg[] = m.connected ? [['32', '●'], ['', ` daemon ${m.port}`], ['2', today > 0 ? ` · ${fmtUsd(today)} today` : ''], ['2', queued ? ` · ${queued} queued` : '']] : [['31', '●'], ['', ' reconnecting…']];
  for (const p of usageParts(m.usage?.rateLimits ?? [], true)) status.push(['2', ' · '], [{ ok: '', warn: '33', bad: '31' }[p.level], p.text]);
  const footer: Seg[] = m.prompt !== undefined ? [['36', m.prompt + '▏']] : [['2', m.notice ?? '^\\ n new · d detach · ? help']];
  const bottom = [rule('├', '┤'), ...actRows.map((r) => frame(paint(r, w))), rule('├', '┤'), frame(paint(status, w)), frame(paint(footer, w)), rule('╰', '╯')];

  const lines = [top], nodeAt: SideLayout['nodeAt'] = [undefined];
  const area = Math.max(0, H - 1 - bottom.length);
  const items3 = tree(m.nodes);
  for (const { n, head, cont } of items3.slice(m.scroll)) {
    const sel = n.id === m.cur, bg = sel ? BG : '';
    const rows: Seg[][] = [lr([['2', head], glyph(n), ['', ' '], [n.status.exited ? '2' : sel || needsYou(n.status) ? '1' : '', n.title], ...(n.unread ? [['36', ' •'] as Seg] : []), ...(n.gate ? [[n.gate === 'failed' ? '31' : '2', ` gate ${n.gate}`] as Seg] : [])], n.status.exited ? 'exited' : `${n.status.stalled ? 'no activity ' : ''}${fmtAge(m.now - n.status.changedAt)}`, w)];
    const act = n.status.activity, o = n.outcome;
    if (act) rows.push([['2', cont], [n.status.state === 'blocked' ? '33' : '2', act]]);
    else if (o) rows.push([['2', cont], [o.outcome === 'failed' ? '31' : '32', outcomeLine(o)]]);
    const mt = meta(n, w - cont.length, subtreeSpend(m.nodes.values(), n.id));
    if (mt.length) rows.push([['2', cont], ...mt]);
    if (lines.length - 1 + rows.length > area) break;
    for (const r of rows) { lines.push(frame(paint(r, w, bg))); nodeAt.push(n.id); }
  }
  while (lines.length < H - bottom.length) { lines.push(frame(' '.repeat(w))); nodeAt.push(undefined); }
  const first = lines.length;
  lines.push(...bottom);
  return { lines: lines.slice(0, H), nodeAt, acts: acts.map((a) => ({ ...a, row: first + 1 + a.row, x0: a.x0 + 1, x1: a.x1 + 1 })) };
}
