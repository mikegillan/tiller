import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { ClientMessage, Dnd, ServerMessage, Usage } from '../shared/protocol.js';
import { loadConfig } from './config.js';
import { DEFAULT_PORT } from './home.js';
import type { NodeManager, NotifyEvent } from './manager.js';
import { mountMcp } from './mcp.js';
import { modApi } from './modapi.js';
import { SPAWN_FIELDS } from './spawnfields.js';
import type { HookEvent } from './status.js';
import { deliver, HUMAN } from './messaging.js';
import { readBody } from './util.js';

const UI_DIR = fileURLToPath(new URL('../../ui/dist', import.meta.url));
const MAX_HOOK_BYTES = 8_000_000; // a PreToolUse payload for a large Write carries the whole file
const AUTH_TIMEOUT_MS = 5000;
const VERSION = (JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version: string }).version;
const CONFIRM_TIMEOUT_MS = 5 * 60_000;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

const id = z.string().min(1);
const size = z.number().int().min(1).max(1000);
const clientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('auth'), token: z.string(), client: z.enum(['app', 'browser', 'mux']).optional() }),
  z.object({ t: z.literal('visibility'), focused: z.boolean() }),
  z.object({ t: z.literal('attach'), id, cols: size, rows: size }),
  z.object({ t: z.literal('detach'), id }),
  z.object({ t: z.literal('input'), id, data: z.string() }),
  z.object({ t: z.literal('resize'), id, cols: size, rows: size }),
  z.object({ t: z.literal('select'), id }),
  z.object({ t: z.literal('spawn'), ...SPAWN_FIELDS, parentId: z.string().nullable().optional() }),
  z.object({ t: z.literal('close'), id, force: z.boolean().optional(), worktree: z.enum(['keep', 'discard']).optional() }),
  z.object({ t: z.literal('merge'), id }),
  z.object({ t: z.literal('restart'), id, prompt: z.string().optional() }),
  z.object({ t: z.literal('resume'), id }),
  z.object({ t: z.literal('prune') }),
  z.object({ t: z.literal('rename'), id, title: z.string() }),
  z.object({ t: z.literal('confirm'), confirmId: z.string(), ok: z.boolean() }),
  z.object({ t: z.literal('diff'), id }),
  z.object({ t: z.literal('send'), id, text: z.string().min(1), mode: z.enum(['queue', 'now']).optional() }),
  z.object({ t: z.literal('mute'), id, muted: z.boolean() }),
  z.object({ t: z.literal('dnd'), on: z.boolean(), minutes: z.number().positive().max(7 * 24 * 60).optional() }),
]) satisfies z.ZodType<ClientMessage>;

export interface DaemonServer {
  port: number;
  /** Ask the human to approve something. Resolves false if no UI is connected, on timeout, or on refusal. */
  confirm(text: string): Promise<boolean>;
  /** How many connected clients are looking at node `id`: it is selected there and their window is in front. */
  watchers(id: string): number;
  /** Whether the native app is connected. */
  appConnected(): boolean;
  /** Do not disturb, as the human last set it; check dndActive for whether it has expired. */
  dnd(): Dnd;
  close(): Promise<void>;
}

interface Client { ws: WebSocket; authed: boolean; attached: Set<string>; kind?: 'app' | 'browser' | 'mux'; focused: boolean; selected?: string }

export async function startServer(manager: NodeManager, opts: { port?: number } = {}): Promise<DaemonServer> {
  const clients = new Set<Client>();
  const pendingConfirms = new Map<string, (ok: boolean) => void>();
  const focus = (from: string, id: string) => broadcast({ t: 'focus', from, id });
  const { handler: mcp, publishAdminToken, authenticate, isAdmin } = mountMcp(manager, (text) => daemon.confirm(text), focus);
  const mod = modApi(manager, authenticate, focus, () => [...new Set([...clients].filter((c) => c.authed && c.kind).map((c) => c.kind!))]);

  const sendTo = (c: Client, m: ServerMessage) => { if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(m)); };
  const broadcast = (m: ServerMessage) => { for (const c of clients) if (c.authed) sendTo(c, m); };
  const appConnected = () => [...clients].some((c) => c.authed && c.kind === 'app');
  manager.isSelected = (id) => [...clients].some((c) => c.selected === id);
  const anyFocused = () => [...clients].some((c) => c.authed && c.focused);
  /** Since when no client has been focused; undefined while one is, or before any ever was. */
  let awaySince: number | undefined;
  let dnd: Dnd = { on: false };
  const noteAway = () => { awaySince = anyFocused() ? undefined : awaySince ?? Date.now(); };

  manager.on('node', (node) => broadcast({ t: 'node', node }));
  manager.on('removed', (rid: string) => {
    for (const c of clients) c.attached.delete(rid);
    broadcast({ t: 'removed', id: rid });
  });
  manager.on('data', (rid: string, data: string) => {
    for (const c of clients) if (c.authed && c.attached.has(rid)) sendTo(c, { t: 'data', id: rid, data });
  });
  manager.on('notify', (n: NotifyEvent) => broadcast({ t: 'notify', ...n }));
  manager.on('usage', (usage: Usage) => broadcast({ t: 'usage', usage }));

  async function handle(c: Client, m: ClientMessage): Promise<void> {
    switch (m.t) {
      case 'auth': return;
      case 'attach': {
        // Snapshot first, then subscribe, so live output is not also part of the snapshot. attach() resolves
        // and we add the client in the same tick, so no chunk can fall between the two.
        const text = await manager.attach(m.id, m.cols, m.rows);
        if (text) sendTo(c, { t: 'data', id: m.id, data: text });
        c.attached.add(m.id);
        return;
      }
      case 'detach': c.attached.delete(m.id); return;
      case 'input': manager.input(m.id, m.data); return;
      case 'resize': manager.resize(m.id, m.cols, m.rows); return;
      case 'visibility': {
        const wasAway = !anyFocused();
        const regained = m.focused && !c.focused;
        c.focused = m.focused;
        if (regained && wasAway && awaySince !== undefined && c.kind !== 'mux') {
          const since = awaySince;
          if (Date.now() - since > loadConfig(null, manager.home).digestAfterMinutes * 60_000) {
            const items = await manager.digest(since);
            if (items.length) sendTo(c, { t: 'digest', since, items });
          }
        }
        noteAway();
        return;
      }
      case 'select': c.selected = m.id; manager.select(m.id); return;
      case 'spawn': {
        const { t: _, ...req } = m;
        await manager.spawn({ ...req, byHuman: true });
        return;
      }
      case 'close': await manager.close(m.id, m.force, m.worktree); return;
      case 'merge': await manager.merge(m.id); return;
      case 'restart': {
        const r = manager.restart(m.id, m.prompt);
        if (!r.ok) sendTo(c, { t: 'error', message: r.error, id: m.id });
        return;
      }
      case 'resume': {
        const r = await manager.resume(m.id);
        if (!r.ok) sendTo(c, { t: 'error', message: r.error, id: m.id });
        return;
      }
      case 'prune': await manager.prune(); return;
      case 'rename': manager.rename(m.id, m.title); return;
      case 'confirm': pendingConfirms.get(m.confirmId)?.(m.ok); return;
      case 'diff': sendTo(c, { t: 'diff', id: m.id, ...(await manager.diff(m.id)) }); return;
      case 'send': sendTo(c, { t: 'sent', id: m.id, result: await deliver(manager, HUMAN, m.id, m.text, { mode: m.mode }) }); return;
      case 'mute': {
        if (!manager.registry.update(m.id, { muted: m.muted || undefined })) { sendTo(c, { t: 'error', message: `no such node: ${m.id}`, id: m.id }); return; }
        console.log(`${m.muted ? 'muted' : 'unmuted'} ${m.id}`);
        const v = manager.view(m.id);
        if (v) manager.emit('node', v);
        return;
      }
      case 'dnd':
        dnd = m.on ? { on: true, ...(m.minutes ? { until: Date.now() + m.minutes * 60_000 } : {}) } : { on: false };
        console.log(`do not disturb ${m.on ? `on${dnd.until ? ` until ${new Date(dnd.until).toLocaleTimeString()}` : ''}` : 'off'}`);
        broadcast({ t: 'dnd', ...dnd });
        return;
    }
  }

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    const c: Client = { ws, authed: false, attached: new Set(), focused: false };
    clients.add(c);
    const authTimer = setTimeout(() => { if (!c.authed) ws.close(4401, 'auth timeout'); }, AUTH_TIMEOUT_MS);
    ws.on('close', () => {
      clearTimeout(authTimer);
      clients.delete(c);
      if (c.focused) noteAway();
      if (c.authed && c.kind === 'app' && !appConnected()) broadcast({ t: 'clients', app: false });
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
        if (msg.t === 'auth' && isAdmin(msg.token)) {
          c.authed = true;
          c.kind = msg.client;
          clearTimeout(authTimer);
          sendTo(c, { t: 'snapshot', nodes: manager.list(), appConnected: appConnected(), usage: manager.usage, dnd });
          if (c.kind === 'app') broadcast({ t: 'clients', app: true });
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
    if (req.method === 'GET' && url.pathname === '/health') {
      return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, pid: process.pid, home: manager.home, version: VERSION }));
    }
    if (req.method === 'POST' && url.pathname === '/hook') return hook(req, res);
    if (await mod(req, res, url.pathname)) return;
    if (url.pathname === '/mcp' || url.pathname.startsWith('/api/')) return mcp(req, res);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/assets/'))) {
      return serveUi(url.pathname === '/' ? 'index.html' : url.pathname.slice(1), res);
    }
    res.writeHead(404).end();
  }

  async function hook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const nodeId = authenticate(req);
    if (!nodeId || nodeId === HUMAN) { res.writeHead(401).end(); return; }
    const body = await readBody(req, res, MAX_HOOK_BYTES);
    if (body === undefined) return;
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

  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(opts.port ?? DEFAULT_PORT, '127.0.0.1', ok); });
  const port = (server.address() as AddressInfo).port;
  manager.endpoint = `http://127.0.0.1:${port}`;
  publishAdminToken();

  const daemon: DaemonServer = {
    port,
    confirm(text) {
      if (![...clients].some((c) => c.authed)) return Promise.resolve(false);
      const confirmId = randomUUID();
      return new Promise<boolean>((resolveConfirm) => {
        const timer = setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS);
        const finish = (ok: boolean) => {
          clearTimeout(timer);
          pendingConfirms.delete(confirmId);
          broadcast({ t: 'confirmDone', confirmId });
          resolveConfirm(ok);
        };
        pendingConfirms.set(confirmId, finish);
        broadcast({ t: 'confirm', confirmId, text });
      });
    },
    watchers: (id) => [...clients].filter((c) => c.authed && c.focused && c.selected === id).length,
    appConnected,
    dnd: () => dnd,
    async close() {
      for (const c of clients) c.ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
  return daemon;
}
