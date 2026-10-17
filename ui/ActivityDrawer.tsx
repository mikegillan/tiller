import { useLayoutEffect, useRef } from 'react';
import { activityUnread, clearActivity, markActivityRead, selectNode, setActivityOpen, useStore } from './store';

export function ActivityButton() {
  const open = useStore((s) => s.activityOpen);
  const unread = useStore((s) => activityUnread(s.activity));
  return (
    <button className="activity-toggle" aria-expanded={open} aria-controls="activity-drawer"
      aria-label={`Activity${unread ? `, ${unread} unread` : ''}`} onClick={() => setActivityOpen(!open)}>
      Activity{unread > 0 && <span className="activity-count">{unread}</span>}
    </button>
  );
}

const LABEL = { info: 'Status', ok: 'Done', warn: 'Needs you', bad: 'Error' } as const;

function OpenDrawer() {
  const items = useStore((s) => s.activity);
  const nodes = useStore((s) => s.nodes);
  const unread = activityUnread(items);
  const close = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    close.current?.focus();
    const escape = (e: KeyboardEvent) => {
      // Native approval/action dialogs own Escape while they are open.
      if (e.key !== 'Escape' || document.querySelector('dialog[open]') || e.defaultPrevented) return;
      e.preventDefault();
      setActivityOpen(false);
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('keydown', escape);
      if (previous instanceof HTMLElement && previous.isConnected && !document.querySelector('dialog[open]')) previous.focus();
    };
  }, []);
  return (
    <aside className="activity-drawer" id="activity-drawer" aria-labelledby="activity-heading">
      <header className="activity-head">
        <h2 id="activity-heading">Activity</h2>
        <button className="btn" ref={close} onClick={() => setActivityOpen(false)}>Close</button>
      </header>
      <div className="activity-tools">
        <span>{items.length} recent · {unread} unread</span>
        <button className="btn" disabled={!unread} onClick={markActivityRead}>Mark all read</button>
        <button className="btn" disabled={!items.length} onClick={clearActivity}>Clear</button>
      </div>
      {items.length ? <ol className="activity-list" aria-label="Recent activity">
        {items.map((item) => {
          const available = !!item.nodeId && !!nodes[item.nodeId];
          return <li key={item.id} className={`activity-item ${item.tone}${item.read ? '' : ' is-unread'}`}>
            <button className="activity-event" disabled={!available} onClick={() => {
              if (item.nodeId && available) { selectNode(item.nodeId); setActivityOpen(false); }
            }}>
              <span className="activity-meta"><strong>{item.nodeName}</strong>
                <time dateTime={new Date(item.at).toISOString()} title={new Date(item.at).toLocaleString()}>
                  {new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </time>
              </span>
              <span className="activity-kind">{LABEL[item.tone]}{!item.read && ' · Unread'}{item.nodeId && !available && ' · Node closed'}</span>
              <span className="activity-message">{item.text}</span>
            </button>
          </li>;
        })}
      </ol> : <div className="activity-empty"><h3>No activity yet</h3><p>Agent updates will appear here as work progresses.</p></div>}
      <p className="activity-foot">Latest 200 events in this window. Select an event to open its node.</p>
    </aside>
  );
}

export function ActivityDrawer() {
  const open = useStore((s) => s.activityOpen);
  return open ? <OpenDrawer /> : null;
}
