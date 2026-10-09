import type { NodeView } from '../src/shared/protocol';

export type StatusKind = 'working' | 'needs' | 'done' | 'errored' | 'exited' | 'unknown';

export function statusKind(n: NodeView): StatusKind {
  const s = n.status;
  if (s.exited) return 'exited';
  if (s.state === 'blocked' || s.state === 'waiting') return 'needs';
  if (s.state === 'working') return 'working';
  if (s.state === 'done') return s.errored ? 'errored' : 'done';
  return 'unknown';
}

export const KIND_LABEL: Record<StatusKind, string> = {
  working: 'working', needs: 'needs you', done: 'done', errored: 'errored', exited: 'exited', unknown: 'unknown',
};

export function fmtAge(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

type Nodes = Record<string, NodeView>;

/** Insert id among its siblings so that siblings stay ordered by changedAt descending. Ties go after existing. */
export function insertSorted(order: string[], nodes: Nodes, n: NodeView): string[] {
  const i = order.findIndex((id) => nodes[id].parentId === n.parentId && nodes[id].status.changedAt < n.status.changedAt);
  return i < 0 ? [...order, n.id] : [...order.slice(0, i), n.id, ...order.slice(i)];
}

export interface Row {
  node: NodeView;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  descendants: NodeView[];
}

/** Flatten to display rows: roots first, children directly under their parent, in `order`. Orphans count as roots. */
export function flattenTree(nodes: Nodes, order: string[], collapsed: string[]): Row[] {
  const kids = new Map<string | null, NodeView[]>();
  for (const id of order) {
    const n = nodes[id];
    if (!n) continue;
    const key = n.parentId && nodes[n.parentId] ? n.parentId : null;
    kids.set(key, [...(kids.get(key) ?? []), n]);
  }
  const all = (id: string): NodeView[] => (kids.get(id) ?? []).flatMap((c) => [c, ...all(c.id)]);
  const rows: Row[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const node of kids.get(parent) ?? []) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      const hasChildren = kids.has(node.id);
      const isCollapsed = hasChildren && collapsed.includes(node.id);
      rows.push({ node, depth, hasChildren, collapsed: isCollapsed, descendants: hasChildren ? all(node.id) : [] });
      if (!isCollapsed) walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}
