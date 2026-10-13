import { fmtUsd, todaySpend } from '../src/shared/spend';
import { useNow } from './hooks';
import { useStore } from './store';
import { needsYou } from './tree';

export function StatusBar() {
  const connected = useStore((s) => s.connected);
  const retry = useStore((s) => s.retry);
  const total = useStore((s) => Object.keys(s.nodes).length);
  const needs = useStore((s) => Object.values(s.nodes).filter(needsYou).length);
  const now = useNow();
  const today = useStore((s) => todaySpend(Object.values(s.nodes), now));
  return (
    <footer className="statusbar" role="status">
      <span className={`conn ${connected ? 'up' : 'down'}`}>
        <i className="dot" />
        {connected ? `daemon connected · ${location.host}` : `reconnecting to ${location.host}${retry > 1 ? ` (attempt ${retry})` : ''}…`}
      </span>
      <span>{total} nodes{needs > 0 && <b className="warn"> · {needs} need you</b>}</span>
      {today > 0 && <span title="spent today, all nodes">{fmtUsd(today)} today</span>}
      <span className="spacer" />
      <span className="keys"><kbd>⌘K</kbd> jump <kbd>⌘1–9</kbd> row <kbd>⌘0</kbd> sidebar</span>
    </footer>
  );
}
