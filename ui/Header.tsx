import { useState } from 'react';
import type { NodeView } from '../src/shared/protocol';
import { send } from './conn';
import { KIND_LABEL, statusKind } from './tree';

export function Header({ node }: { node: NodeView }) {
  const [editing, setEditing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const kind = statusKind(node);
  const commit = (v: string) => {
    setEditing(false);
    if (v.trim() && v !== node.title) send({ t: 'rename', id: node.id, title: v.trim() });
  };
  return (
    <header className="header" key={node.id}>
      {editing ? (
        <input
          className="rename" autoFocus defaultValue={node.title}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(e.currentTarget.value); if (e.key === 'Escape') setEditing(false); }}
        />
      ) : (
        <h1 title="Click to rename" onClick={() => setEditing(true)}>{node.title}</h1>
      )}
      <span className="kindtag">{node.kind}</span>
      <span className={`state ${kind}`}>{KIND_LABEL[kind]}</span>
      <span className="meta" title={node.cwd}>{node.cwd}</span>
      {node.model && <span className="meta">{node.model}</span>}
      {node.status.activity && <span className="meta activity">{node.status.activity}</span>}
      <span className="spacer" />
      {node.status.exited && <button onClick={() => send({ t: 'resume', id: node.id })}>Resume</button>}
      {confirmClose ? (
        <>
          <span className="meta">Close this node?</span>
          <button className="danger" onClick={() => { setConfirmClose(false); send({ t: 'close', id: node.id }); }}>Yes, close</button>
          <button onClick={() => setConfirmClose(false)}>Cancel</button>
        </>
      ) : (
        <button onClick={() => setConfirmClose(true)}>Close</button>
      )}
    </header>
  );
}
