// Fake daemon for developing the UI without the real one. Token: "mock".
//   node ui/mock-server.mjs            ws on :7789; also serves ui/dist at http://127.0.0.1:7789/?k=mock when it has been built
// Mutations (spawn, close, rename, resume, prune, select) work in memory; a confirm request arrives 15 s after connecting.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.O8_MOCK_PORT ?? 7789);
const DIST = fileURLToPath(new URL('./dist', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const now = Date.now();
const MIN = 60_000;
const nodes = new Map();
const add = (id, parentId, title, cwd, kind, { ago = 0, ...st } = {}, extra = {}) =>
  nodes.set(id, {
    id, parentId, title, cwd, kind, createdAt: now - 3 * 3600_000, unread: false, ...extra,
    status: { state: kind === 'terminal' ? 'none' : 'working', changedAt: now - ago, ...st },
  });
const OPUS = { model: 'claude-opus-5-5', effort: 'high' };
const SONNET = { model: 'claude-sonnet-5-5', effort: 'medium' };
const HAIKU = { model: 'claude-haiku-4-5', effort: 'low' };

// Session 1: this repo.
add('o8', null, 'orchestr8', '/Users/scott/workspace/orchestr8', 'claude', { ...OPUS, ago: 20_000, activity: 'Task: polish the UI', contextPct: 42, contextTokens: 84_000, contextWindow: 200_000, costUsd: 3.42, lastAssistantMessage: 'I split the work into three children: ui polish, tests, and daemon. Waiting on tests to finish its dependency reinstall.' });
add('o8-ui', 'o8', 'ui polish', '/Users/scott/workspace/orchestr8/ui', 'claude', { ...SONNET, ago: 4_000, activity: 'Edit: ui/NodeRow.tsx', contextPct: 71, contextTokens: 142_000, contextWindow: 200_000, costUsd: 1.18 }, { unread: true });
add('o8-css', 'o8-ui', 'css review', '/Users/scott/workspace/orchestr8/ui', 'claude', { ...HAIKU, state: 'done', ago: 12 * MIN, contextPct: 18, contextTokens: 36_000, contextWindow: 200_000, costUsd: 0.07, lastAssistantMessage: 'Reviewed theme.css and sidebar.css.\n\nFindings:\n- The connector lines use border colours from --line, good in both themes.\n- .actions overlaps the age on narrow widths; consider hiding the age at hover (already done).\n- No hard-coded colours outside theme.css except the toast shadow.' });
add('o8-sh', 'o8-ui', 'shell', '/Users/scott/workspace/orchestr8/ui', 'terminal', { ago: 40 * MIN });
add('o8-test', 'o8', 'tests', '/Users/scott/workspace/orchestr8', 'claude', { ...SONNET, state: 'blocked', ago: 90_000, activity: 'needs approval: Bash: rm -rf node_modules && npm ci && npm test -- --run ui', contextPct: 23, contextTokens: 46_000, contextWindow: 200_000, costUsd: 0.31 }, { unread: true });
add('o8-d', 'o8', 'daemon', '/Users/scott/workspace/orchestr8', 'claude', { ...OPUS, state: 'done', ago: 25 * MIN, contextPct: 86, contextTokens: 172_000, contextWindow: 200_000, costUsd: 6.9, lastAssistantMessage: 'The daemon now serves ui/dist and reports /health. All 214 tests pass.' });
add('o8-spike', 'o8', 'spike: tauri', '/Users/scott/workspace/orchestr8', 'claude', { ...SONNET, state: 'done', exited: true, ago: 5 * 3600_000, contextPct: 55, contextTokens: 110_000, contextWindow: 200_000, costUsd: 2.05, lastAssistantMessage: 'Tauri wraps the same ui/dist; WKWebView needs the DOM renderer.' });

// Session 2: another project.
add('dc', null, 'dotcms-core', '/Users/scott/code/dotcms-core', 'claude', { ...SONNET, ago: 2 * MIN, activity: 'Bash: ./mvnw -pl dotCMS test', contextPct: 88, contextTokens: 176_000, contextWindow: 200_000, costUsd: 4.4 });
add('dc-mig', 'dc', 'migration', '/Users/scott/code/dotcms-core', 'claude', { ...OPUS, state: 'done', errored: true, ago: 8 * MIN, contextPct: 61, contextTokens: 122_000, contextWindow: 200_000, costUsd: 2.6, lastAssistantMessage: 'StopFailure: the turn ended with an API error (overloaded). Retry or resume.' });
add('dc-b', 'dc', 'build', '/Users/scott/code/dotcms-core', 'terminal', { ago: 3 * MIN });

// Session 3: scratch work, idle.
add('sc', null, 'scratch', '/tmp/scratch', 'claude', { ...HAIKU, state: 'done', ago: 3 * 3600_000, contextPct: 9, contextTokens: 18_000, contextWindow: 200_000, costUsd: 0.02, lastAssistantMessage: 'Done: wrote /tmp/scratch/out.csv with 120 rows.' });

const SCREENS = {
  claude: (n) => `\x1b[1;36m● ${n.title}\x1b[0m  \x1b[2m${n.cwd}\x1b[0m\r\n\r\n\x1b[2m> \x1b[0mplease keep going\r\n\r\n\x1b[32m✓\x1b[0m Read ui/store.ts\r\n\x1b[32m✓\x1b[0m Edit ui/NodeRow.tsx \x1b[2m(+24 -6)\x1b[0m\r\n\x1b[33m●\x1b[0m ${n.status.activity ?? 'Thinking…'}\r\n\r\n\x1b[2m╭────────────────────────────────────────────╮\r\n│\x1b[0m > \x1b[7m \x1b[0m                                         \x1b[2m│\r\n╰────────────────────────────────────────────╯\x1b[0m\r\n`,
  terminal: (n) => `\x1b[32m${n.cwd.split('/').pop()}\x1b[0m \x1b[34m$\x1b[0m `,
};

const clients = new Set();
const view = (n) => n;
const broadcast = (m) => clients.forEach((c) => c.ws.send(JSON.stringify(m)));
const touch = (n, patch) => { Object.assign(n.status, patch, { changedAt: Date.now() }); broadcast({ t: 'node', node: view(n) }); };

// Light life: the working node's context creeps up.
setInterval(() => {
  const n = nodes.get('o8-ui');
  if (n && !n.status.exited && n.status.contextPct < 95) touch(n, { contextPct: n.status.contextPct + 1, costUsd: +(n.status.costUsd + 0.02).toFixed(2) });
}, 8000);

const http = createServer(async (req, res) => {
  const path = normalize(new URL(req.url, 'http://x').pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const file = await readFile(join(DIST, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? (path === '/' ? 'text/html' : 'application/octet-stream') }).end(file);
  } catch { res.writeHead(404).end('not found (run npm run ui:build to serve the UI from here)'); }
});

const wss = new WebSocketServer({ server: http, path: '/ws' });
wss.on('connection', (ws) => {
  const client = { ws, attached: new Set() };
  const send = (m) => ws.send(JSON.stringify(m));
  let authed = false;
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (!authed) {
      if (m.t !== 'auth' || m.token !== 'mock') return ws.close();
      authed = true;
      clients.add(client);
      send({ t: 'snapshot', nodes: [...nodes.values()].map(view) });
      setTimeout(() => ws.readyState === 1 && send({ t: 'confirm', confirmId: 'c1', text: 'ui polish wants to close node "shell".\nIt has been idle for 40 minutes.' }), 15_000);
      return;
    }
    const n = nodes.get(m.id);
    switch (m.t) {
      case 'attach': if (n) send({ t: 'data', id: m.id, data: SCREENS[n.kind](n) }); break;
      case 'input': send({ t: 'data', id: m.id, data: m.data === '\r' ? '\r\n$ ' : m.data }); break;
      case 'select': if (n?.unread) { n.unread = false; broadcast({ t: 'node', node: view(n) }); } break;
      case 'rename': if (n) { n.title = m.title; broadcast({ t: 'node', node: view(n) }); } break;
      case 'resume': if (n) touch(n, { exited: false, state: n.kind === 'terminal' ? 'none' : 'working' }); break;
      case 'close': if (n) { nodes.delete(m.id); broadcast({ t: 'removed', id: m.id }); } break;
      case 'prune': for (const x of [...nodes.values()]) if (x.status.exited && ![...nodes.values()].some((c) => c.parentId === x.id)) { nodes.delete(x.id); broadcast({ t: 'removed', id: x.id }); } break;
      case 'spawn': {
        const id = `n${nodes.size + 1}${Date.now() % 1000}`;
        add(id, m.parentId ?? null, m.title, m.cwd, m.kind, { model: m.model ?? 'claude-sonnet-5-5' });
        broadcast({ t: 'node', node: view(nodes.get(id)) });
        break;
      }
      case 'confirm': broadcast({ t: 'confirmDone', confirmId: m.confirmId }); break;
    }
  });
  ws.on('close', () => clients.delete(client));
});

http.listen(PORT, '127.0.0.1', () => console.log(`mock daemon on http://127.0.0.1:${PORT} (ws /ws, token "mock"); UI at /?k=mock after npm run ui:build`));
