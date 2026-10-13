import { NEEDS_YOU_STATES, type NodeView } from '../src/shared/protocol';

export type StatusKind = 'working' | 'needs' | 'done' | 'errored' | 'exited' | 'unknown';

export function statusKind(n: NodeView): StatusKind {
  const s = n.status;
  if (s.exited) return 'exited';
  if (NEEDS_YOU_STATES.includes(s.state)) return 'needs';
  if (s.state === 'working') return 'working';
  if (s.state === 'done') return s.errored ? 'errored' : 'done';
  return 'unknown';
}

export const needsYou = (n: NodeView) => statusKind(n) === 'needs';

export const KIND_LABEL: Record<StatusKind, string> = {
  working: 'working', needs: 'needs you', done: 'done', errored: 'errored', exited: 'exited', unknown: 'idle',
};

export type Nodes = Record<string, NodeView>;

/** Insert id among its siblings so that siblings stay ordered by changedAt descending. Ties go after existing. */
export function insertSorted(order: string[], nodes: Nodes, n: NodeView): string[] {
  const i = order.findIndex((id) => nodes[id].parentId === n.parentId && nodes[id].status.changedAt < n.status.changedAt);
  return i < 0 ? [...order, n.id] : [...order.slice(0, i), n.id, ...order.slice(i)];
}

export interface Row {
  node: NodeView;
  /** 0 for the session root. */
  depth: number;
  /** One entry per ancestor strictly between the root and this node: does that ancestor have later siblings (draw a vertical line)? */
  guides: boolean[];
  /** Last among its siblings (elbow instead of tee). */
  last: boolean;
  hasChildren: boolean;
  collapsed: boolean;
  descendants: NodeView[];
}

/** Display rows for one session: the root, then its descendants depth-first in `order`; children of collapsed nodes are omitted. */
export function flattenSession(nodes: Nodes, order: string[], rootId: string, collapsed: string[]): Row[] {
  const kids = new Map<string, NodeView[]>();
  for (const id of order) {
    const n = nodes[id];
    if (n?.parentId && nodes[n.parentId]) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  }
  const all = (id: string): NodeView[] => (kids.get(id) ?? []).flatMap((c) => [c, ...all(c.id)]);
  const rows: Row[] = [];
  const walk = (node: NodeView, depth: number, guides: boolean[], last: boolean) => {
    const cs = kids.get(node.id) ?? [];
    const isCollapsed = cs.length > 0 && collapsed.includes(node.id);
    rows.push({ node, depth, guides, last, hasChildren: cs.length > 0, collapsed: isCollapsed, descendants: all(node.id) });
    if (isCollapsed) return;
    const childGuides = depth === 0 ? [] : [...guides, !last];
    cs.forEach((c, i) => walk(c, depth + 1, childGuides, i === cs.length - 1));
  };
  if (nodes[rootId]) walk(nodes[rootId], 0, [], true);
  return rows;
}
