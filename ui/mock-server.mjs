// Fake daemon: serves two nodes on ws://127.0.0.1:7789/ws and echoes input back as data. Token: "mock".
import { WebSocketServer } from 'ws';

const now = Date.now();
const mk = (id, title, kind, parentId, state, ago) => ({
  id, title, kind, parentId, cwd: '/tmp', createdAt: now - ago, unread: false,
  ...(kind === 'claude' ? { model: 'sonnet' } : {}),
  status: { state, changedAt: now - ago, ...(state === 'working' ? { activity: 'Bash: npm test' } : {}) },
});
const nodes = [mk('n1', 'planner', 'claude', null, 'working', 180_000), mk('n2', 'shell', 'terminal', 'n1', 'none', 3_600_000)];

const wss = new WebSocketServer({ port: 7789, path: '/ws' });
wss.on('connection', (ws) => {
  const send = (m) => ws.send(JSON.stringify(m));
  let authed = false;
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (!authed) {
      if (m.t !== 'auth' || m.token !== 'mock') return ws.close();
      authed = true;
      return send({ t: 'snapshot', nodes });
    }
    if (m.t === 'attach') send({ t: 'data', id: m.id, data: `attached to ${m.id}\r\n$ ` });
    else if (m.t === 'input') send({ t: 'data', id: m.id, data: m.data === '\r' ? '\r\n$ ' : m.data });
    else if (m.t === 'spawn') send({ t: 'error', message: 'mock server cannot spawn' });
  });
});
console.log('mock daemon on ws://127.0.0.1:7789/ws (token "mock")');
