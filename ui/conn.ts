import type { ClientMessage, ServerMessage } from '../src/shared/protocol';
import { applyServer, setConnected } from './store';
import { getTerm } from './terminals';
import { armOnFirstClick, handleNotify } from './notify';
import { IN_APP, token } from './url';

let ws: WebSocket | undefined;
let attempt = 0;
/** The daemon's sha when this page loaded; a daemon on another sha (after an update) serves a new UI bundle. */
let loadedSha: string | undefined;

export function send(m: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

/** Tell the daemon whether this window is in front, so it skips OS notifications for the node being looked at. */
const sendVisibility = () => send({ t: 'visibility', focused: document.hasFocus() && !document.hidden });

export function connect() {
  armOnFirstClick();
  for (const ev of ['focus', 'blur']) addEventListener(ev, sendVisibility);
  document.addEventListener('visibilitychange', sendVisibility);
  open();
}

function open() {
  const sock = (ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`));
  sock.onopen = () => {
    attempt = 0;
    send({ t: 'auth', token: token(), client: IN_APP ? 'app' : 'browser' });
    sendVisibility();
    setConnected(true); // TermViews re-attach on this transition
  };
  sock.onmessage = (e) => {
    let m: ServerMessage;
    try { m = JSON.parse(String(e.data)); } catch { return; }
    if (m.t === 'snapshot' && m.update?.sha) {
      loadedSha ??= m.update.sha;
      if (m.update.sha !== loadedSha) return location.reload();
    }
    if (m.t === 'data') getTerm(m.id)?.term.write(m.data);
    else if (m.t === 'notify') handleNotify(m);
    else applyServer(m);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    setConnected(false, attempt + 1);
    setTimeout(open, Math.min(10000, 500 * 2 ** attempt++));
  };
}
