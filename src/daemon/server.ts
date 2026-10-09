import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';
import type { NodeManager, NotifyEvent } from './manager.js';
import { mountMcp } from './mcp.js';
import type { HookEvent } from './status.js';

const UI_DIR = fileURLToPath(new URL('../../ui/dist', import.meta.url));
const MAX_HOOK_BYTES = 1_000_000;
const AUTH_TIMEOUT_MS = 5000;
const CONFIRM_TIMEOUT_MS = 5 * 60_000;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

const id = z.string().min(1);
const size = z.number().int().min(1).max(1000);
const clientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('auth'), token: z.string() }),
  z.object({ t: z.literal('attach'), id, cols: size, rows: size }),
  z.object({ t: z.literal('detach'), id }),
  z.object({ t: z.literal('input'), id, data: z.string() }),
  z.object({ t: z.literal('resize'), id, cols: size, rows: size }),
  z.object({ t: z.literal('select'), id }),
  z.object({
    t: z.literal('spawn'), kind: z.enum(['claude', 'terminal']), title: z.string(), cwd: z.string().min(1),
    prompt: z.string().optional(), model: z.string().optional(), parentId: z.string().nullable().optional(),
  }),
  z.object({ t: z.literal('close'), id }),
  z.object({ t: z.literal('resume'), id }),
  z.object({ t: z.literal('rename'), id, title: z.string() }),
  z.object({ t: z.literal('confirm'), confirmId: z.string(), ok: z.boolean() }),
]) satisfies z.ZodType<ClientMessage>;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface DaemonServer {
  port: number;
  /** Token the UI must send as its first WebSocket message. */
  uiToken: string;
  /** URL to open in the browser. */
  url: string;
  /** Ask the human to approve something. Resolves false if no UI is connected, on timeout, or on refusal. */
  confirm(text: string): Promise<boolean>;
  close(): Promise<void>;
}

interface Client { ws: WebSocket; authed: boolean; attached: Set<string> }

export async function startServer(manager: NodeManager, opts: { port?: number; uiToken?: string } = {}): Promise<DaemonServer> {
  const uiToken = opts.uiToken ?? randomBytes(24).toString('base64url');
  const clients = new Set<Client>();
  const pendingConfirms = new Map<string, (ok: boolean) => void>();
  const mcp = mountMcp(manager, (text) => daemon.confirm(text));

  const sendTo = (c: Client, m: ServerMessage) => { if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(m)); };
  const broadcast = (m: ServerMessage) => { for (const c of clients) if (c.authed) sendTo(c, m); };

  manager.on('node', (node) => broadcast({ t: 'node', node }));
  manager.on('removed', (rid: string) => {
    for (const c of clients) c.attached.delete(rid);
    broadcast({ t: 'removed', id: rid });
  });
  manager.on('data', (rid: string, data: string) => {
    for (const c of clients) if (c.authed && c.attached.has(rid)) sendTo(c, { t: 'data', id: rid, data });
  });
  manager.on('notify', (n: NotifyEvent) => broadcast({ t: 'notify', ...n }));

  async function handle(c: Client, m: ClientMessage): Promise<void> {
    switch (m.t) {
      case 'auth': return;
      case 'attach': {
        c.attached.add(m.id);
        const text = await manager.attach(m.id, m.cols, m.rows);
        if (text) sendTo(c, { t: 'data', id: m.id, data: text.replaceAll('\n', '\r\n') });
        return;
      }
      case 'detach': c.attached.delete(m.id); return;
      case 'input': manager.input(m.id, m.data); return;
      case 'resize': manager.resize(m.id, m.cols, m.rows); return;
      case 'select': manager.select(m.id, c); return;
      case 'spawn': manager.spawn({ kind: m.kind, title: m.title, cwd: m.cwd, prompt: m.prompt, model: m.model, parentId: m.parentId }); return;
      case 'close': manager.close(m.id); return;
      case 'resume': {
        const r = manager.resume(m.id);
        if (!r.ok) sendTo(c, { t: 'error', message: r.error, id: m.id });
        return;
      }
      case 'rename': manager.rename(m.id, m.title); return;
      case 'confirm': pendingConfirms.get(m.confirmId)?.(m.ok); return;
    }
  }

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    const c: Client = { ws, authed: false, attached: new Set() };
    clients.add(c);
    const authTimer = setTimeout(() => { if (!c.authed) ws.close(4401, 'auth timeout'); }, AUTH_TIMEOUT_MS);
    ws.on('close', () => {
      clearTimeout(authTimer);
      clients.delete(c);
      manager.deselect(c);
    });
    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = clientMessage.parse(JSON.parse(raw.toString()));
      } catch {
        if (!c.authed) ws.close(4401, 'auth required');
        else sendTo(c, { t: 'error', message: 'Malformed message' });
        return;
      }
      if (!c.authed) {
        if (msg.t === 'auth' && safeEqual(msg.token, uiToken)) {
          c.authed = true;
          clearTimeout(authTimer);
          sendTo(c, { t: 'snapshot', nodes: manager.list() });
        } else {
          ws.close(4401, 'auth required');
        }
        return;
      }
      handle(c, msg).catch((err: Error) => sendTo(c, { t: 'error', message: err.message, id: 'id' in msg ? msg.id : undefined }));
    });
  });

  const server = http.createServer((req, res) => {
    route(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname === '/ws') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    else socket.destroy();
  });

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'POST' && url.pathname === '/hook') return hook(req, res);
    if (url.pathname === '/mcp' || url.pathname.startsWith('/api/')) return mcp(req, res);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/assets/'))) {
      return serveUi(url.pathname === '/' ? 'index.html' : url.pathname.slice(1), res);
    }
    res.writeHead(404).end();
  }

  async function hook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const nodeId = String(req.headers['x-o8-node'] ?? '');
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (!nodeId || !manager.verifyToken(nodeId, bearer)) { res.writeHead(401).end(); return; }
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_HOOK_BYTES) { res.writeHead(413).end(); req.destroy(); return; }
    }
    let event: HookEvent;
    try {
      event = JSON.parse(body);
      if (typeof event?.hook_event_name !== 'string') throw new Error('no event name');
    } catch {
      res.writeHead(400).end();
      return;
    }
    manager.applyHook(nodeId, event);
    res.writeHead(204).end();
  }

  async function serveUi(rel: string, res: http.ServerResponse): Promise<void> {
    const file = resolve(UI_DIR, rel);
    if (!file.startsWith(UI_DIR + sep)) { res.writeHead(404).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      if (rel === 'index.html') res.writeHead(200, { 'Content-Type': 'text/plain' }).end('UI not built');
      else res.writeHead(404).end();
    }
  }

  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(opts.port ?? 7788, '127.0.0.1', ok); });
  const port = (server.address() as AddressInfo).port;
  manager.endpoint = `http://127.0.0.1:${port}`;

  const daemon: DaemonServer = {
    port,
    uiToken,
    url: `${manager.endpoint}/?k=${uiToken}`,
    confirm(text) {
      if (![...clients].some((c) => c.authed)) return Promise.resolve(false);
      const confirmId = randomUUID();
      return new Promise<boolean>((resolveConfirm) => {
        const timer = setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS);
        const finish = (ok: boolean) => { clearTimeout(timer); pendingConfirms.delete(confirmId); resolveConfirm(ok); };
        pendingConfirms.set(confirmId, finish);
        broadcast({ t: 'confirm', confirmId, text });
      });
    },
    async close() {
      for (const c of clients) c.ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
  return daemon;
}
