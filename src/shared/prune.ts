import type { NodeView } from './protocol.js';

/** Ids of exited nodes that have no live descendant: removing them never orphans a running node. */
export function pruneIds(nodes: NodeView[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const keep = new Set<string>();
  for (const n of nodes) {
    if (n.status.exited) continue;
    for (let p = n.parentId ? byId.get(n.parentId) : undefined; p && !keep.has(p.id); p = p.parentId ? byId.get(p.parentId) : undefined) keep.add(p.id);
  }
  return nodes.filter((n) => n.status.exited && !keep.has(n.id)).map((n) => n.id);
}
