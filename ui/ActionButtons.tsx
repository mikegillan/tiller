import type { NodeView } from '../src/shared/protocol';
import { canMerge } from './Bits';
import { send } from './conn';
import { Icon, type IconName } from './icons';
import { openDialog, setRenaming } from './store';

interface Act { key: string; label: string; icon: IconName; run: () => void; danger?: boolean }

export function actionsFor(node: NodeView): Act[] {
  const exited = !!node.status.exited;
  const last: Act = node.parentId === null // an orchestrator is restarted, never closed
    ? { key: 'restart', label: 'Restart', icon: 'restart', run: () => openDialog({ kind: 'restart', id: node.id }) }
    : exited
      ? { key: 'remove', label: 'Remove', icon: 'trash', danger: true, run: () => node.worktree ? openDialog({ kind: 'kill', id: node.id }) : send({ t: 'close', id: node.id }) }
      : { key: 'kill', label: 'Kill', icon: 'x', danger: true, run: () => openDialog({ kind: 'kill', id: node.id }) };
  return [
    ...(!exited ? [{ key: 'child', label: 'New child', icon: 'subnode' as const, run: () => openDialog({ kind: 'spawn', parentId: node.id, cwd: node.cwd }) }] : []),
    { key: 'rename', label: 'Rename', icon: 'edit', run: () => setRenaming(node.id) },
    ...(exited ? [{ key: 'resume', label: 'Resume', icon: 'play' as const, run: () => send({ t: 'resume', id: node.id }) }] : []),
    ...(canMerge(node) ? [{ key: 'merge', label: `Merge into ${node.status.git!.base}`, icon: 'merge' as const, run: () => send({ t: 'merge', id: node.id }) }] : []),
    last,
  ];
}

/** Icon buttons for a node; `labels` adds text next to each icon (title bar). */
export function ActionButtons({ node, labels }: { node: NodeView; labels?: boolean }) {
  return (
    <span className={`actions${labels ? ' labelled' : ''}`}>
      {actionsFor(node).map((a) => (
        <button key={a.key} className={`btn icon${a.danger ? ' danger' : ''}`} title={a.label} aria-label={a.label}
          onClick={(e) => { e.stopPropagation(); a.run(); }}>
          <Icon name={a.icon} size={14} />{labels && <span>{a.label}</span>}
        </button>
      ))}
    </span>
  );
}
