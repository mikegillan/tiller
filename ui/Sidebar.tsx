import { useEffect, useMemo, useRef } from 'react';
import { send } from './conn';
import { Icon } from './icons';
import { NodeRow } from './NodeRow';
import { SessionSwitcher } from './SessionSwitcher';
import { flattenSession, type Row } from './tree';
import { openDialog, selectNode, toggleCollapsed, useStore } from './store';

export function useRows(): Row[] {
  const nodes = useStore((s) => s.nodes);
  const order = useStore((s) => s.order);
  const session = useStore((s) => s.session);
  const collapsed = useStore((s) => s.collapsed);
  return useMemo(() => (session ? flattenSession(nodes, order, session, collapsed) : []), [nodes, order, session, collapsed]);
}

/** j/k (or arrows) move the selection, h/l collapse and expand. Only reached when focus is in the sidebar. */
function onKey(e: React.KeyboardEvent, rows: Row[], selected: string | null) {
  if ((e.target as HTMLElement).tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
  const i = rows.findIndex((r) => r.node.id === selected);
  const row = rows[i];
  const go = (j: number) => { const r = rows[Math.min(rows.length - 1, Math.max(0, j))]; if (r) { e.preventDefault(); selectNode(r.node.id); } };
  if (e.key === 'j' || e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'k' || e.key === 'ArrowUp') go(i - 1);
  else if (row && (e.key === 'h' || e.key === 'ArrowLeft') && row.hasChildren && !row.collapsed) toggleCollapsed(row.node.id);
  else if (row && (e.key === 'l' || e.key === 'ArrowRight') && row.collapsed) toggleCollapsed(row.node.id);
}

export function Sidebar() {
  const rows = useRows();
  const selected = useStore((s) => s.selected);
  const exited = useStore((s) => Object.values(s.nodes).filter((n) => n.status.exited).length);
  const tree = useRef<HTMLDivElement>(null);
  const cur = useStore((s) => (s.selected ? s.nodes[s.selected] : undefined));

  // Keep the selected row in view when selection moves (keyboard, palette, focus message).
  useEffect(() => { tree.current?.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' }); }, [selected]);

  return (
    <aside className="sidebar" data-sidebar>
      <SessionSwitcher />
      <div className="tree" role="tree" tabIndex={0} ref={tree} onKeyDown={(e) => onKey(e, rows, selected)}>
        {rows.map((r) => <NodeRow key={r.node.id} row={r} />)}
        {!rows.length && <p className="hint">No sessions yet.</p>}
      </div>
      <footer className="sidefoot">
        <button className="btn" disabled={!cur || !!cur.status.exited} onClick={() => cur && openDialog({ kind: 'spawn', parentId: cur.id, cwd: cur.cwd })}>
          <Icon name="subnode" size={14} />New child
        </button>
        <button className="btn" disabled={!exited} onClick={() => send({ t: 'prune' })} title="Remove exited nodes that have no live descendant">
          <Icon name="trash" size={14} />Clear exited{exited ? ` (${exited})` : ''}
        </button>
      </footer>
    </aside>
  );
}
