import type { NodeView } from '../src/shared/protocol';
import { ActionButtons } from './ActionButtons';
import { NodeMeta, StateDot } from './Bits';
import { Icon } from './icons';
import { RenameInput } from './RenameInput';
import { ancestry } from './sessions';
import { selectNode, togglePanel, useStore } from './store';
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
  const kind = statusKind(node);
  const s = node.status;
  return (
    <header className="titlebar" key={node.id}>
      <div className="tb1">
        <Breadcrumb node={node} />
        <span className={`badge ${kind}`}><StateDot kind={kind} />{KIND_LABEL[kind]}{s.errored && s.interrupted ? ' (interrupted)' : ''}</span>
        <span className="spacer" />
        <ActionButtons node={node} labels />
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
