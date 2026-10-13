import { dndActive } from '../src/shared/protocol';
import { fmtAge, usageParts } from '../src/shared/format';
import { fmtUsd, todaySpend } from '../src/shared/spend';
import { toggleDnd, useNow } from './hooks';
import { useStore } from './store';
import { needsYou } from './tree';

export function StatusBar() {
  const connected = useStore((s) => s.connected);
  const retry = useStore((s) => s.retry);
  const total = useStore((s) => Object.keys(s.nodes).length);
  const needs = useStore((s) => Object.values(s.nodes).filter(needsYou).length);
  const queued = useStore((s) => Object.values(s.nodes).filter((n) => n.status.state === 'queued').length);
  const usage = useStore((s) => s.usage);
  const now = useNow();
  const today = useStore((s) => todaySpend(Object.values(s.nodes), now));
  const dnd = useStore((s) => s.dnd);
  const quiet = dndActive(dnd, now);
  return (
    <footer className="statusbar" role="status">
      <span className={`conn ${connected ? 'up' : 'down'}`}>
        <i className="dot" />
        {connected ? `daemon connected · ${location.host}` : `reconnecting to ${location.host}${retry > 1 ? ` (attempt ${retry})` : ''}…`}
      </span>
      <span>{total} nodes{needs > 0 && <b className="warn"> · {needs} need you</b>}{queued > 0 && ` · ${queued} queued`}</span>
      {usage && (
        <span title={`Claude usage for the account, reported by ${usage.nodeId} ${fmtAge(Date.now() - usage.at)} ago`}>
          {usageParts(usage.rateLimits).map((p, i) => (
            <span key={i} className={`ctx ${p.level}`}>{i > 0 && ' · '}<span className="pct">{p.text}</span></span>
          ))}
        </span>
      )}
      {today > 0 && <span title="spent today, all nodes">{fmtUsd(today)} today</span>}
      <span className="spacer" />
      <button className={`dnd${quiet ? ' on' : ''}`} onClick={toggleDnd} title={quiet ? 'Turn off do not disturb' : 'No OS notifications for an hour'}>
        {quiet ? `do not disturb${dnd!.until ? ` · ${Math.ceil((dnd!.until - now) / 60_000)} min left` : ''}` : 'do not disturb 1 h'}
      </button>
      <span className="keys"><kbd>⌘K</kbd> jump <kbd>⌘1–9</kbd> row <kbd>⌘0</kbd> sidebar</span>
    </footer>
  );
}
