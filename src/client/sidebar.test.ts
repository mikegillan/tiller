import { expect, test } from 'vitest';
import type { NodeView } from '../shared/protocol.js';
import { layoutSidebar, meta, tree } from './sidebar.js';

const node = (id: string, title: string, parentId: string | null, status: Partial<NodeView['status']> = {}, extra: Partial<NodeView> = {}): NodeView =>
  ({ id, title, parentId, kind: 'claude', cwd: '/r', createdAt: 0, unread: false, status: { state: 'working', changedAt: 0, ...status }, ...extra });
const nodes = new Map([
  node('a', 'boss', null, { model: 'claude-opus-5-5', effort: 'high', contextPct: 42, contextTokens: 84000, contextWindow: 200000, costUsd: 0.42, activity: 'Bash: npm test' }),
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
  expect(L.acts.map((a) => a.act)).toEqual(['new', 'rename', 'kill', 'orch', 'sidebar', 'help']);
});

test('meta line drops detail as the width shrinks and colors ctx by usage', () => {
  const n = nodes.get('a')!;
  expect(plain(meta(n, 45).map((s) => s[1]).join(''))).toBe('opus 5.5 · high · ctx 42% (84k/200k) $0.42');
  expect(meta(n, 30).map((s) => s[1]).join('')).toBe('opus 5.5 · high · ctx 42%');
  expect(meta(n, 15).map((s) => s[1]).join('')).toBe('opus 5.5 · ctx 42%');
  expect(meta(n, 45).find((s) => s[1].startsWith('ctx'))![0]).toBe('32');
  expect(meta({ ...n, status: { ...n.status, contextPct: 90 } }, 40).find((s) => s[1].startsWith('ctx'))![0]).toBe('31');
});
