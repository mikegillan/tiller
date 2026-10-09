import type { ClientMessage, ServerMessage } from '../src/shared/protocol';
import { applyServer, setConnected } from './store';
import { getTerm } from './terminals';
import { armOnFirstClick, handleNotify } from './notify';

/** Read `?k=` once, keep it in localStorage, and remove it from the address bar. */
const urlKey = new URLSearchParams(location.search).get('k');
if (urlKey) {
  try { localStorage.setItem('o8.k', urlKey); } catch { /* storage unavailable; the in-memory copy still works */ }
  history.replaceState(null, '', location.pathname);
}

function token(): string {
  try { return urlKey ?? localStorage.getItem('o8.k') ?? ''; } catch { return urlKey ?? ''; }
}

let ws: WebSocket | undefined;
let attempt = 0;

export function send(m: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

export function connect() {
  armOnFirstClick();
  open();
}

function open() {
  const sock = (ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`));
  sock.onopen = () => {
    attempt = 0;
    send({ t: 'auth', token: token() });
    setConnected(true); // TermViews re-attach on this transition
  };
  sock.onmessage = (e) => {
    let m: ServerMessage;
    try { m = JSON.parse(String(e.data)); } catch { return; }
    if (m.t === 'data') getTerm(m.id)?.term.write(m.data);
    else if (m.t === 'notify') handleNotify(m);
    else applyServer(m);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    setConnected(false);
    setTimeout(open, Math.min(10000, 500 * 2 ** attempt++));
  };
}
