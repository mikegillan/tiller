// Spend roll-ups over node records, shared by the daemon (list_nodes) and the web UI.
import type { NodeRecord } from './protocol.js';
import { treeOrder } from './tree.js';

type Spender = Pick<NodeRecord, 'id' | 'parentId' | 'spentUsd' | 'spentToday'>;

/** Local calendar day as YYYY-MM-DD. */
export const dayKey = (at: number) => new Date(at).toLocaleDateString('en-CA');

/** The node's own spend plus that of every descendant in `nodes` (no cycle guard: parentId is fixed at spawn). */
export function subtreeSpend(nodes: Iterable<Spender>, id: string): number {
  const all = [...nodes], root = all.find((n) => n.id === id);
  return root ? treeOrder(all, root).reduce((sum, { node }) => sum + (node.spentUsd ?? 0), 0) : 0;
}

/** Spend today across `nodes`. */
export function todaySpend(nodes: Iterable<Spender>, now: number): number {
  const day = dayKey(now);
  let sum = 0;
  for (const n of nodes) if (n.spentToday?.day === day) sum += n.spentToday.usd;
  return sum;
}

export const fmtUsd = (usd: number) => `$${usd.toFixed(2)}`;
