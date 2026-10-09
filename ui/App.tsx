import { useEffect, useMemo, useState } from 'react';
import { selectNode, useStore } from './store';
import { flattenTree } from './tree';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { TerminalPane } from './TerminalPane';
import { Toasts, ConfirmModal } from './Toasts';
import { Palette } from './Palette';

export function App() {
  const [palette, setPalette] = useState(false);
  const { nodes, order, collapsed, selected, connected } = useStore((s) => s);
  const rows = useMemo(() => flattenTree(nodes, order, collapsed), [nodes, order, collapsed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key === 'k') { e.preventDefault(); setPalette((p) => !p); }
      else if (/^[1-9]$/.test(e.key)) {
        const row = rows[Number(e.key) - 1];
        if (row) { e.preventDefault(); selectNode(row.node.id); }
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [rows]);

  return (
    <div className="app">
      <Sidebar rows={rows} />
      <main className="main">
        {!connected && <div className="offline">Disconnected, reconnecting...</div>}
        {selected && nodes[selected] ? <Header node={nodes[selected]} /> : <div className="empty">Select or create a node</div>}
        <TerminalPane />
      </main>
      <Toasts />
      <ConfirmModal />
      {palette && <Palette rows={rows} onClose={() => setPalette(false)} />}
    </div>
  );
}
