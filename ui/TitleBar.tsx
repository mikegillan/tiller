import type { NodeView } from '../src/shared/protocol';
import { ActionButtons } from './ActionButtons';
import { NodeMeta, StateDot } from './Bits';
import { Icon } from './icons';
import { RenameInput } from './RenameInput';
import { ancestry } from './sessions';
import { selectNode, showPane, togglePanel, useStore } from './store';
import { KIND_LABEL, statusKind } from './tree';

function Breadcrumb({ node }: { node: NodeView }) {
  const nodes = useStore((s) => s.nodes);
  const renaming = useStore((s) => s.renaming === node.id);
  const chain = ancestry(nodes, node.id);
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {chain.slice(0, -1).map((n) => (
        <span key={n.id} className="crumb-wrap">
          <button className="crumb" onClick={() => selectNode(n.id)}>{n.title}</button>
          <Icon name="chevron" size={12} />
        </span>
      ))}
      {renaming ? <RenameInput id={node.id} title={node.title} /> : <h1 title={node.title}>{node.title}</h1>}
    </nav>
  );
}

export function TitleBar({ node }: { node: NodeView }) {
  const panel = useStore((s) => s.panel);
  const diff = useStore((s) => s.diffOpen) && !!node.worktree;
  const transcript = useStore((s) => s.transcriptOpen) && node.kind === 'claude';
  const tabs = [
    { key: 'terminal', label: 'Terminal', on: !diff && !transcript, show: true },
    { key: 'diff', label: 'Diff', on: diff, show: !!node.worktree },
    { key: 'transcript', label: 'Transcript', on: transcript, show: node.kind === 'claude' },
  ] as const;
  const kind = statusKind(node);
  const s = node.status;
  return (
    <header className="titlebar" key={node.id}>
      <div className="tb1">
        <Breadcrumb node={node} />
        <span className={`badge ${kind}`}><StateDot kind={kind} />{KIND_LABEL[kind]}{s.errored && s.interrupted ? ' (interrupted)' : ''}</span>
        <span className="spacer" />
        <ActionButtons node={node} labels />
        {tabs.filter((t) => t.show).length > 1 && (
          <div className="seg tabs" role="group" aria-label="Pane">
            {tabs.filter((t) => t.show).map((t) => (
              <button key={t.key} className={t.on ? 'on' : ''} aria-pressed={t.on} onClick={() => showPane(t.key)}>{t.label}</button>
            ))}
          </div>
        )}
        <button className={`btn icon${panel ? ' on' : ''}`} title="Last message" aria-label="Toggle last message panel" aria-pressed={panel} onClick={togglePanel}>
          <Icon name="panel" size={14} />
        </button>
      </div>
      <div className="tb2">
        <span className="cwd" title={node.cwd}>{node.cwd}</span>
        <span className="tag">{node.kind}</span>
        {s.permissionMode && s.permissionMode !== 'default' && <span className="tag">{s.permissionMode}</span>}
        <NodeMeta node={node} detail />
      </div>
    </header>
  );
}
