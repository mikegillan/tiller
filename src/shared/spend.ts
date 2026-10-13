// Spend roll-ups over node records, shared by the daemon (list_nodes), the web UI and the mux sidebar.
import type { NodeRecord } from './protocol.js';

type Spender = Pick<NodeRecord, 'id' | 'parentId' | 'spentUsd' | 'spentToday'>;

/** Local calendar day as YYYY-MM-DD. */
export const dayKey = (at: number) => new Date(at).toLocaleDateString('en-CA');

/** The node's own spend plus that of every descendant in `nodes`. */
export function subtreeSpend(nodes: Iterable<Spender>, id: string): number {
  const all = [...nodes], seen = new Set<string>(), todo = [id];
  let sum = 0;
  for (let cur = todo.pop(); cur !== undefined; cur = todo.pop()) {
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const n of all) {
      if (n.id === cur) sum += n.spentUsd ?? 0;
      if (n.parentId === cur) todo.push(n.id);
    }
  }
  return sum;
}

/** Spend today across `nodes`. */
export function todaySpend(nodes: Iterable<Spender>, now: number): number {
  const day = dayKey(now);
  let sum = 0;
  for (const n of nodes) if (n.spentToday?.day === day) sum += n.spentToday.usd;
  return sum;
}

export const fmtUsd = (usd: number) => `$${usd.toFixed(2)}`;
