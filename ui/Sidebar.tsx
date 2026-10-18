import { useEffect, useMemo, useRef } from 'react';
import { send } from './conn';
import { HistoryPanel } from './History';
import { Icon } from './icons';
import { NodeRow } from './NodeRow';
import { SessionSwitcher } from './SessionSwitcher';
import { SidebarResize } from './SidebarResize';
import { flattenSession, type Row } from './tree';
import { selectNode, toggleCollapsed, toggleHistory, useStore } from './store';

export function useRows(): Row[] {
  const nodes = useStore((s) => s.nodes);
  const order = useStore((s) => s.order);
  const session = useStore((s) => s.session);
  const collapsed = useStore((s) => s.collapsed);
  return useMemo(() => (session ? flattenSession(nodes, order, session, collapsed) : []), [nodes, order, session, collapsed]);
}

/** j/k (or arrows) move the selection, h/l collapse and expand. Only reached when focus is in the sidebar. */
function onKey(e: React.KeyboardEvent, rows: Row[], selected: string | null) {
  if ((e.target as HTMLElement).closest('button, input, textarea, select, a, [role="menu"], [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return;
  const i = rows.findIndex((r) => r.node.id === selected);
  const row = rows[i];
  const go = (j: number) => {
    const r = rows[Math.min(rows.length - 1, Math.max(0, j))];
    if (!r) return;
    e.preventDefault();
    selectNode(r.node.id);
    Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')).find((el) => el.dataset.id === r.node.id)?.focus();
  };
  if (e.key === 'j' || e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'k' || e.key === 'ArrowUp') go(i - 1);
  else if (row && (e.key === 'h' || e.key === 'ArrowLeft') && row.hasChildren && !row.collapsed) { e.preventDefault(); toggleCollapsed(row.node.id); }
  else if (row && (e.key === 'l' || e.key === 'ArrowRight') && row.collapsed) { e.preventDefault(); toggleCollapsed(row.node.id); }
}

export function Sidebar({ onSettings }: { onSettings: () => void }) {
  const rows = useRows();
  const selected = useStore((s) => s.selected);
  const exited = useStore((s) => Object.values(s.nodes).filter((n) => n.status.exited).length);
  const tree = useRef<HTMLDivElement>(null);
  const tabStop = rows.some((r) => r.node.id === selected) ? selected : rows[0]?.node.id;
  const history = useStore((s) => s.historyOpen);
  const panelOpen = useStore((s) => s.panel);

  // Keep the selected row in view when selection moves (keyboard, palette, focus message).
  useEffect(() => { tree.current?.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' }); }, [selected]);

  return (
    <aside className="sidebar">
      <SessionSwitcher />
      {history ? <HistoryPanel /> : (
        <div className="tree" role="tree" aria-label="Session agents" tabIndex={rows.length ? -1 : 0} ref={tree} onKeyDown={(e) => onKey(e, rows, selected)}>
          {rows.map((r) => <NodeRow key={r.node.id} row={r} tabStop={r.node.id === tabStop} />)}
          {!rows.length && <p className="hint">No sessions yet.</p>}
        </div>
      )}
      <footer className="sidefoot">
        <button className="btn" onClick={onSettings}>Settings</button>
        <button className="btn" disabled={!exited} onClick={() => send({ t: 'prune' })} title="Remove exited nodes that have no live descendant">
          <Icon name="trash" size={14} />Clear exited{exited ? ` (${exited})` : ''}
        </button>
        <button className={`btn hist${history ? ' on' : ''}`} aria-pressed={history} onClick={toggleHistory} title="History: closed nodes to read, follow up or fork" aria-label="History">
          <Icon name="history" size={14} />History
        </button>
      </footer>
      <SidebarResize panelOpen={panelOpen} />
    </aside>
  );
}
