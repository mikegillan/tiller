import { expect, test } from 'vitest';
import type { NodeView } from '../shared/protocol.js';
import { layoutSidebar, meta, revealScroll, tree } from './sidebar.js';

const node = (id: string, title: string, parentId: string | null, status: Partial<NodeView['status']> = {}, extra: Partial<NodeView> = {}): NodeView =>
  ({ id, title, parentId, kind: 'claude', cwd: '/r', createdAt: 0, unread: false, status: { state: 'working', changedAt: 0, ...status }, ...extra });
const nodes = new Map([
  node('a', 'boss', null, { model: 'claude-opus-5-5', effort: 'high', contextPct: 42, contextTokens: 84000, contextWindow: 200000, costUsd: 0.1, activity: 'Bash: npm test' }, { spentUsd: 0.42 }),
  node('b', 'builder', 'a', { state: 'blocked', activity: 'needs approval: rm -rf build' }, { unread: true }),
  node('c', 'tester', 'a', { state: 'done' }),
  node('d', 'sub', 'b', { state: 'done', exited: true }),
].map((n) => [n.id, n]));
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('tree connectors: roots bare, children with ├─ / └─ and guides under non-last siblings', () => {
  expect(tree(nodes).map((t) => t.head + t.n.id)).toEqual(['a', '├─ b', '│  └─ d', '└─ c']);
});

test('layout: framed rows, selection, activity, meta line, action bar and footer', () => {
  const L = layoutSidebar({ nodes, cur: 'b', scroll: 0, now: 5000, port: 7788, connected: true }, 30, 24);
  const p = L.lines.map(plain);
  expect(p.every((l) => l.length === 30)).toBe(true);
  expect(p[0]).toBe('╭─ orchestr8 4 ──────────────╮');
  expect(p[1]).toBe('│● boss                    5s│');
  expect(p[2]).toBe('│  Bash: npm test            │');
  expect(p[3]).toBe('│  opus 5.5 · high · ctx 42% │');
  expect(p[4]).toBe('│├─ ! builder •            5s│');
  expect(p[5]).toBe('││    needs approval: rm -rf…│');
  expect(p.at(-1)).toBe('╰────────────────────────────╯');
  expect(p.at(-2)).toBe('│^\\ n new · d detach · ? help│');
  expect(p.at(-3)).toBe('│● daemon 7788               │');
  expect(L.lines[4]).toContain('48;5;236');
  expect(L.lines[1]).not.toContain('48;5;236');
  expect(L.nodeAt.slice(1, 6)).toEqual(['a', 'a', 'a', 'b', 'b']);
  expect(L.acts.map((a) => a.act)).toEqual(['new', 'rename', 'kill', 'clear', 'orch', 'sidebar', 'help']);
});

test('meta line drops detail as the width shrinks and colors ctx by usage', () => {
  const n = nodes.get('a')!;
  expect(plain(meta(n, 45).map((s) => s[1]).join(''))).toBe('opus 5.5 · high · ctx 42% (84k/200k) $0.42');
  expect(meta(n, 30).map((s) => s[1]).join('')).toBe('opus 5.5 · high · ctx 42%');
  expect(meta(n, 15).map((s) => s[1]).join('')).toBe('opus 5.5 · ctx 42%');
  expect(meta(n, 45).find((s) => s[1].startsWith('ctx'))![0]).toBe('32');
  expect(meta({ ...n, status: { ...n.status, contextPct: 90 } }, 40).find((s) => s[1].startsWith('ctx'))![0]).toBe('31');
  const w = { ...n, worktree: { repo: '/r', path: '/r/w', branch: 'o8/n-3f2a9c1d', base: 'main', baseSha: 'abc' } };
  expect(meta(w, 60).map((s) => s[1]).join('')).toBe('⎇ n-3f2a · opus 5.5 · high · ctx 42% (84k/200k) $0.42');
  expect(meta(w, 45).map((s) => s[1]).join('')).toBe('opus 5.5 · high · ctx 42% (84k/200k) $0.42'); // the branch goes first
  const git = { branch: 'o8/n-3f2a9c1d', base: 'main', ahead: 1, behind: 0, dirty: 2, additions: 0, deletions: 0 };
  expect(meta({ ...w, status: { ...w.status, git } }, 70).map((s) => s[1]).join('')).toBe('⎇ n-3f2a ↑1●2 · opus 5.5 · high · ctx 42% (84k/200k) $0.42');
  expect(meta({ ...w, worktree: { ...w.worktree, missing: true }, status: { ...w.status, git: { ...git, ahead: 0, dirty: 0, mergedAt: 1 } } }, 70)[0]).toEqual(['33', '⎇ n-3f2a merged']);
});

test('spend: own and subtree (Σ) on the meta line, today total in the status line; a stalled row says no activity', () => {
  const n = nodes.get('a')!;
  expect(meta(n, 60, 1.5).map((s) => s[1]).join('')).toBe('opus 5.5 · high · ctx 42% (84k/200k) $0.42 Σ$1.50');
  expect(meta(nodes.get('c')!, 40, 0.3).map((s) => s[1]).join('')).toBe('$0.00 Σ$0.30'); // no own spend, children have some
  const now = Date.now(), day = new Date(now).toLocaleDateString('en-CA');
  const spent = new Map([
    node('r', 'root', null, { stalled: true, changedAt: now - 7 * 60_000 }, { spentUsd: 2, spentToday: { day, usd: 1.25 } }),
    node('k', 'kid', 'r', {}, { spentUsd: 3, spentToday: { day: '2000-01-01', usd: 3 } }), // another day: not today
  ].map((x) => [x.id, x]));
  const p = layoutSidebar({ nodes: spent, cur: 'r', scroll: 0, now, port: 7788, connected: true }, 40, 24).lines.map(plain);
  expect(p[1]).toMatch(/● root\s+no activity 7m│$/);
  expect(p[2]).toMatch(/^│ {2}\$2\.00 Σ\$5\.00 +│$/);
  expect(p.at(-3)).toBe('│● daemon 7788 · $1.25 today           │');
});

test('exited rows read "exited" with a dim ○ and title; revealScroll brings a far-down selection into view', () => {
  const L = layoutSidebar({ nodes, cur: 'a', scroll: 0, now: 5000, port: 7788, connected: true }, 30, 24);
  const row = L.lines.findIndex((l) => plain(l).includes('sub'));
  expect(plain(L.lines[row]!)).toMatch(/○ sub\s+exited/);
  expect(L.lines[row]).toContain('\x1b[0;2m○');
  const many = new Map(Array.from({ length: 30 }, (_, i) => node(`n${i}`, `node${i}`, null, { exited: i < 29, activity: i % 2 ? 'x' : undefined })).map((n) => [n.id, n]));
  const m = { nodes: many, cur: 'n29', scroll: 0, now: 0, port: 1, connected: true };
  const s = revealScroll(m, 30, 24, 29);
  expect(layoutSidebar({ ...m, scroll: s }, 30, 24).nodeAt).toContain('n29');
  expect(revealScroll({ ...m, cur: 'n0' }, 30, 24, 0)).toBe(0);
});

test('the action bar offers restart instead of kill for a root', () => {
  const acts = (cur: string) => layoutSidebar({ nodes, cur, scroll: 0, now: 5000, port: 7788, connected: true }, 60, 24).acts.map((a) => a.act);
  expect(acts('a')).toEqual(['new', 'rename', 'restart', 'clear', 'orch', 'sidebar', 'help']);
  expect(acts('b')).toContain('kill');
  expect(acts('b')).not.toContain('restart');
});

test('control characters in agent-supplied text never reach the terminal; wide characters count two cells', () => {
  const evil = new Map([node('a', 'x\x1b]52;c;aGk=\x07\x1b[2Jy', null, { activity: 'Bash: \x9b31m' }), node('b', '世界世界世界世界世界世界', 'a')].map((n) => [n.id, n]));
  const L = layoutSidebar({ nodes: evil, cur: 'a', scroll: 0, now: 0, port: 1, connected: true, notice: 'bad\x1bc' }, 30, 24);
  for (const l of L.lines) expect(l.replace(/\x1b\[[0-9;]*m/g, '')).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  expect(plain(L.lines[1]!)).toMatch(/x]52;c;aGk=\[2Jy +now│$/);
  const row = plain(L.lines.find((l) => plain(l).includes('世'))!);
  expect([...row].reduce((a, ch) => a + (ch >= '世' && ch <= '界' ? 2 : 1), 0)).toBe(30);
});
