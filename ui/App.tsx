import { useEffect } from 'react';
import { Dialogs } from './Dialogs';
import { DiffPane } from './DiffPane';
import { ExitedCard } from './ExitedCard';
import { useDocumentSync } from './hooks';
import { LastMessagePanel } from './LastMessagePanel';
import { Palette } from './Palette';
import { Sidebar, useRows } from './Sidebar';
import { StatusBar } from './StatusBar';
import { TerminalPane } from './TerminalPane';
import { TitleBar } from './TitleBar';
import { ConfirmModal, Toasts } from './Toasts';
import { getState, openDialog, selectNode, useStore } from './store';
import { IN_APP } from './url';

if (IN_APP) document.documentElement.dataset.app = '1';

export function App() {
  const rows = useRows();
  const node = useStore((s) => (s.selected ? s.nodes[s.selected] : undefined));
  const panel = useStore((s) => s.panel);
  const palette = useStore((s) => s.dialog?.kind === 'palette');
  const diff = useStore((s) => s.diffOpen) && !!node?.worktree;
  useDocumentSync();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.shiftKey) return; // Ctrl must reach the terminal
      if (e.key === 'k') { e.preventDefault(); openDialog(getState().dialog?.kind === 'palette' ? null : { kind: 'palette' }); }
      else if (e.key === '0') { e.preventDefault(); document.querySelector<HTMLElement>('.tree')?.focus(); }
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
      {IN_APP && <div className="dragstrip" data-tauri-drag-region />}
      <Sidebar />
      <main className="main">
        {node ? <TitleBar node={node} /> : null}
        <div className="work">
          <div className="stage">
            <TerminalPane />
            {diff ? <DiffPane node={node!} /> : node?.status.exited && <ExitedCard node={node} />}
            {!node && (
              <div className="empty">
                <p>No sessions yet.</p>
                <button className="btn primary" onClick={() => openDialog({ kind: 'spawn', parentId: null, cwd: '' })}>New session</button>
              </div>
            )}
          </div>
          {panel && <LastMessagePanel />}
        </div>
      </main>
      <StatusBar />
      <Toasts />
      <ConfirmModal />
      <Dialogs />
      {palette && <Palette />}
    </div>
  );
}
