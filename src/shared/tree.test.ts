import { expect, it } from 'vitest';
import { treeOrder } from './tree.js';

it('walks depth-first and treats a node whose parent is missing as a root', () => {
  const nodes = [
    { id: 'a', parentId: null }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'gone' }, { id: 'd', parentId: 'c' }, { id: 'e', parentId: 'a' },
  ];
  expect(treeOrder(nodes).map((t) => `${t.node.id}${t.depth}${t.lasts.map(Number).join('')}`)).toEqual(['a00', 'b100', 'e101', 'c01', 'd111']);
  expect(treeOrder(nodes, nodes[2]).map((t) => t.node.id)).toEqual(['c', 'd']);
});
