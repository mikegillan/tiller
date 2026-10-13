export interface TreeItem<T> {
  node: T;
  /** 0 for a root. */
  depth: number;
  /** One flag per level from the root down to this node: is the node at that level last among its siblings? */
  lasts: boolean[];
}

/** Depth-first tree order: each root (or just `root`), then its descendants. A node whose parent is missing is a root. */
export function treeOrder<T extends { id: string; parentId: string | null }>(nodes: Iterable<T>, root?: T): TreeItem<T>[] {
  const all = [...nodes], ids = new Set(all.map((n) => n.id));
  const kids = (pid: string | null) => all.filter((n) => (n.parentId && ids.has(n.parentId) ? n.parentId : null) === pid);
  const out: TreeItem<T>[] = [];
  const walk = (ns: T[], lasts: boolean[]) => ns.forEach((node, i) => {
    const mine = [...lasts, i === ns.length - 1];
    out.push({ node, depth: lasts.length, lasts: mine });
    walk(kids(node.id), mine);
  });
  walk(root ? [root] : kids(null), []);
  return out;
}
