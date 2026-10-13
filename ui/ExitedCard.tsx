import type { NodeView } from '../src/shared/protocol';
import { send } from './conn';
import { Icon } from './icons';
import { openDialog } from './store';

/** Sits over the last screen of an exited node. */
export function ExitedCard({ node }: { node: NodeView }) {
  return (
    <div className="exited-overlay" role="alertdialog" aria-label={`${node.title} has exited`}>
      <div className="card">
        <h2>{node.title} has exited</h2>
        <p>The process is no longer running. Resume continues the session where it left off.</p>
        <div className="btns">
          <button className="btn primary" autoFocus onClick={() => send({ t: 'resume', id: node.id })}><Icon name="play" size={14} />Resume</button>
          {node.parentId === null
            ? <button className="btn" onClick={() => openDialog({ kind: 'restart', id: node.id })}><Icon name="restart" size={14} />Restart</button>
            : <button className="btn danger" onClick={() => send({ t: 'close', id: node.id })}><Icon name="trash" size={14} />Remove</button>}
        </div>
      </div>
    </div>
  );
}
