import { fmtAge } from '../src/shared/format';
import { OutcomeDetails } from './Bits';
import { useNow } from './hooks';
import { useStore } from './store';

export function LastMessagePanel() {
  const node = useStore((s) => (s.selected ? s.nodes[s.selected] : undefined));
  const now = useNow();
  const msg = node?.status.lastAssistantMessage;
  return (
    <aside className="panel" aria-label="Last message">
      <h2>Last message{node && <span className="age">{fmtAge(now - node.status.changedAt)} ago</span>}</h2>
      {node?.outcome && <OutcomeDetails o={node.outcome} />}
      {msg ? <div className="msg">{msg}</div> : <p className="hint">No message from this node yet.</p>}
    </aside>
  );
}
