import { describe, expect, it } from 'vitest';
import type { NodeView } from '../src/shared/protocol';
import { fmtAge, flattenTree, insertSorted } from './tree';

const mk = (id: string, parentId: string | null, changedAt: number): NodeView => ({
  id, parentId, kind: 'claude', title: id, cwd: '/', createdAt: 0, unread: false,
  status: { state: 'working', changedAt },
});

describe('tree', () => {
  it('insertSorted places a new node among its siblings by changedAt descending, ignoring other groups', () => {
    const a = mk('a', null, 300), b = mk('b', null, 100), x = mk('x', 'a', 999);
    const nodes = { a, b, x };
    const n = mk('n', null, 200);
    expect(insertSorted(['a', 'x', 'b'], nodes, n)).toEqual(['a', 'x', 'n', 'b']);
    expect(insertSorted(['a', 'x', 'b'], nodes, mk('o', null, 50))).toEqual(['a', 'x', 'b', 'o']);
    expect(insertSorted(['a', 'x', 'b'], nodes, mk('t', null, 300))).toEqual(['a', 'x', 't', 'b']);
  });

  it('flattenTree lists roots first with children indented under their parent, in given order', () => {
    const nodes = Object.fromEntries([mk('a', null, 3), mk('c1', 'a', 2), mk('b', null, 1), mk('c2', 'a', 1), mk('g', 'c1', 1), mk('orphan', 'gone', 0)].map((n) => [n.id, n]));
    const order = ['a', 'c1', 'b', 'c2', 'g', 'orphan'];
    expect(flattenTree(nodes, order, []).map((r) => [r.node.id, r.depth])).toEqual([
      ['a', 0], ['c1', 1], ['g', 2], ['c2', 1], ['b', 0], ['orphan', 0],
    ]);
  });

  it('flattenTree hides children of collapsed parents but exposes them as descendants', () => {
    const nodes = Object.fromEntries([mk('a', null, 3), mk('c1', 'a', 2), mk('g', 'c1', 1)].map((n) => [n.id, n]));
    const rows = flattenTree(nodes, ['a', 'c1', 'g'], ['a']);
    expect(rows.map((r) => r.node.id)).toEqual(['a']);
    expect(rows[0].collapsed).toBe(true);
    expect(rows[0].descendants.map((d) => d.id)).toEqual(['c1', 'g']);
  });

  it('fmtAge', () => {
    expect([0, 59_000, 180_000, 3_600_000, 90_000_000].map(fmtAge)).toEqual(['now', 'now', '3m', '1h', '1d']);
  });
});
