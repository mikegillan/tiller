import { describe, expect, it } from 'vitest';
import type { NodeView } from '../src/shared/protocol';
import { mk } from './fixtures';
import { flattenSession, insertSorted, kindTag, statusKind } from './tree';

const byId = (ns: NodeView[]) => Object.fromEntries(ns.map((n) => [n.id, n]));

describe('tree', () => {
  it('insertSorted places a new node among its siblings by changedAt descending, ignoring other groups', () => {
    const a = mk('a', null, 300), b = mk('b', null, 100), x = mk('x', 'a', 999);
    const nodes = { a, b, x };
    expect(insertSorted(['a', 'x', 'b'], nodes, mk('n', null, 200))).toEqual(['a', 'x', 'n', 'b']);
    expect(insertSorted(['a', 'x', 'b'], nodes, mk('o', null, 50))).toEqual(['a', 'x', 'b', 'o']);
    expect(insertSorted(['a', 'x', 'b'], nodes, mk('t', null, 300))).toEqual(['a', 'x', 't', 'b']);
  });

  it('flattenSession lists one session depth-first and ignores other roots', () => {
    const nodes = byId([mk('a', null, 3), mk('c1', 'a', 2), mk('b', null, 1), mk('c2', 'a', 1), mk('g', 'c1', 1)]);
    const order = ['a', 'c1', 'b', 'c2', 'g'];
    expect(flattenSession(nodes, order, 'a', []).map((r) => [r.node.id, r.depth])).toEqual([['a', 0], ['c1', 1], ['g', 2], ['c2', 1]]);
    expect(flattenSession(nodes, order, 'b', []).map((r) => r.node.id)).toEqual(['b']);
  });

  it('flattenSession marks connectors: elbow on the last sibling, vertical guides under ancestors that have later siblings', () => {
    const nodes = byId([mk('a', null, 0), mk('c1', 'a', 0), mk('g1', 'c1', 0), mk('g2', 'c1', 0), mk('c2', 'a', 0), mk('h', 'c2', 0)]);
    const rows = flattenSession(nodes, ['a', 'c1', 'g1', 'g2', 'c2', 'h'], 'a', []);
    expect(rows.map((r) => [r.node.id, r.last, r.guides])).toEqual([
      ['a', true, []],
      ['c1', false, []],
      ['g1', false, [true]],   // c1 has a later sibling (c2): line continues beside its children
      ['g2', true, [true]],
      ['c2', true, []],
      ['h', true, [false]],    // c2 is last: no line beside its child
    ]);
  });

  it('flattenSession hides children of collapsed parents but exposes them as descendants', () => {
    const nodes = byId([mk('a', null, 3), mk('c1', 'a', 2), mk('g', 'c1', 1)]);
    const rows = flattenSession(nodes, ['a', 'c1', 'g'], 'a', ['c1']);
    expect(rows.map((r) => r.node.id)).toEqual(['a', 'c1']);
    expect(rows[1].collapsed).toBe(true);
    expect(rows[1].descendants.map((d) => d.id)).toEqual(['g']);
  });

  it('kindTag names a Pi agent "pi" and keeps claude and terminal as they are', () => {
    expect(kindTag({ ...mk('a', null, 0), kind: 'agent', harness: 'pi' })).toBe('pi');
    expect(kindTag(mk('a', null, 0))).toBe('claude');
    expect(kindTag({ ...mk('a', null, 0), kind: 'terminal' })).toBe('terminal');
  });

  it('statusKind maps state and flags', () => {
    expect(statusKind(mk('a', null, 0, { state: 'blocked' }))).toBe('needs');
    expect(statusKind(mk('a', null, 0, { state: 'done', errored: true }))).toBe('errored');
    expect(statusKind(mk('a', null, 0, { state: 'working', exited: true }))).toBe('exited');
    expect(statusKind(mk('a', null, 0, { state: 'none' }))).toBe('unknown');
  });
});
