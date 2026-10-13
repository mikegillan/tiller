import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';
import { NodeManager } from './manager.js';
import { startServer, type DaemonServer } from './server.js';

let home: string;
let manager: NodeManager;
let server: DaemonServer;
let ws: WebSocket | undefined;
let seen: ServerMessage[];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'o8-'));
  manager = new NodeManager({ home, shell: '/bin/sh' });
  server = await startServer(manager, { port: 0 });
  seen = [];
});

afterEach(async () => {
  ws?.terminate();
  manager.shutdown();
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

const adminToken = () => readFileSync(join(home, 'admin-token'), 'utf8');

async function connect(token = adminToken(), client?: 'app' | 'browser' | 'mux'): Promise<void> {
  ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  ws.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
  await new Promise((ok, fail) => { ws!.once('open', ok); ws!.once('error', fail); });
  send({ t: 'auth', token, client });
}
const send = (m: ClientMessage) => ws!.send(JSON.stringify(m));

async function until<T>(find: () => T | undefined, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    const v = find();
    if (v) return v;
  }
  throw new Error(`timed out; saw ${JSON.stringify(seen).slice(0, 500)}`);
}

describe('websocket', () => {
  it('rejects a bad token', async () => {
    await connect('wrong');
    const code = await new Promise((ok) => ws!.once('close', ok));
    expect(code).toBe(4401);
    expect(seen).toEqual([]);
  });

  it('runs a terminal node end to end', async () => {
    await connect();
    await until(() => seen.find((m) => m.t === 'snapshot'));
    send({ t: 'spawn', kind: 'terminal', title: 'sh', cwd: tmpdir() });
    const created = await until(() => seen.find((m) => m.t === 'node'));
    if (created.t !== 'node') throw new Error('unreachable');
    const id = created.node.id;
    expect(created.node.status.state).toBe('none');

    send({ t: 'attach', id, cols: 80, rows: 24 });
    send({ t: 'input', id, data: 'echo hi\r' });
    await until(() => seen.find((m) => m.t === 'data' && m.id === id && m.data.includes('hi')));

    send({ t: 'close', id }); // a root is an orchestrator: refused without force
    await until(() => seen.find((m) => m.t === 'error' && m.id === id && /orchestrator/.test(m.message)));
    expect(manager.list()).toHaveLength(1);
    send({ t: 'restart', id });
    await until(() => seen.find((m) => m.t === 'data' && m.id === id && m.data === '\x1bc'));
    expect(manager.list().map((n) => n.id)).toEqual([id]);
    send({ t: 'close', id, force: true });
    await until(() => seen.find((m) => m.t === 'removed' && m.id === id));
    expect(manager.list()).toEqual([]);
  });
});

describe('POST /hook', () => {
  const post = (nodeId: string, token: string, body: object) => fetch(`${manager.endpoint}/hook`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-O8-Node': nodeId, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('rejects a wrong token and drives status with a right one', async () => {
    await connect();
    await until(() => seen.find((m) => m.t === 'snapshot'));
    const node = manager.spawn({ kind: 'terminal', title: 'agent', cwd: tmpdir() });
    const token = manager.tokenFor(node.id);
    expect((await post(node.id, 'bad', { hook_event_name: 'Stop' })).status).toBe(401);
    expect((await post('n-other', token, { hook_event_name: 'Stop' })).status).toBe(401);

    expect((await post(node.id, token, { hook_event_name: 'UserPromptSubmit', prompt: 'x' })).status).toBe(204);
    await until(() => seen.find((m) => m.t === 'node' && m.node.status.state === 'working'));
    expect((await post(node.id, token, { hook_event_name: 'Stop', last_assistant_message: 'all done' })).status).toBe(204);
    const notify = await until(() => seen.find((m) => m.t === 'notify'));
    expect(notify).toMatchObject({ t: 'notify', id: node.id, kind: 'done', title: 'agent', body: 'all done' });

    const states = seen.flatMap((m) => (m.t === 'node' && m.node.id === node.id ? [m.node.status.state] : []));
    expect(states).toContain('working');
    expect(states.at(-1)).toBe('done');
    expect(manager.view(node.id)?.unread).toBe(true);
  });

  it('serves the mod API: auth, inbox, mod-event measure and tree', async () => {
    const parent = manager.spawn({ kind: 'terminal', title: 'boss', cwd: tmpdir() });
    const kid = manager.spawn({ kind: 'terminal', title: 'kid', cwd: tmpdir(), parentId: parent.id });
    const call = (path: string, id: string, token: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'X-O8-Node': id, 'Content-Type': 'application/json' } });
    const tp = manager.tokenFor(parent.id), tk = manager.tokenFor(kid.id);
    expect((await call('/inbox', parent.id, 'bad')).status).toBe(401);
    expect((await call('/tree', kid.id, tp)).status).toBe(401); // another node's token
    expect(await (await call('/inbox', kid.id, tk)).json()).toEqual([]);
    const measure = { event: 'session.measure', payload: { context: { tokens: 1, window: 2, percent: 50 }, cost: { usd: 0.25 } } };
    expect((await call('/mod-event', kid.id, tk, { method: 'POST', body: JSON.stringify(measure) })).status).toBe(204);
    expect((await call('/mod-event', kid.id, tk, { method: 'POST', body: '{"event":"nope"}' })).status).toBe(400);
    expect(manager.view(kid.id)?.status).toMatchObject({ contextPct: 50, costUsd: 0.25 });
    expect(manager.view(kid.id)?.status).toMatchObject({ contextTokens: 1, contextWindow: 2 });
    const done = { event: 'turn.complete', payload: { durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', usage: { model: 'claude-sonnet-5-5' } } };
    expect((await call('/mod-event', kid.id, tk, { method: 'POST', body: JSON.stringify(done) })).status).toBe(204);
    expect(manager.view(kid.id)?.status).toMatchObject({ model: 'claude-sonnet-5-5', contextPct: 50 });
    expect(await (await call('/tree', parent.id, tp)).json()).toMatchObject([
      { id: parent.id, title: 'boss', depth: 0, self: true, parentId: null },
      { id: kid.id, title: 'kid', depth: 1, contextPct: 50 },
    ]);
  });

  it('mod-event rateLimits: keeps the newest report from any node, broadcasts it, drops a malformed one', async () => {
    const a = manager.spawn({ kind: 'terminal', title: 'a', cwd: tmpdir() });
    const b = manager.spawn({ kind: 'terminal', title: 'b', cwd: tmpdir() });
    const post = (id: string, payload: unknown) => fetch(`http://127.0.0.1:${server.port}/mod-event`, {
      method: 'POST', body: JSON.stringify({ event: 'session.measure', payload }),
      headers: { Authorization: `Bearer ${manager.tokenFor(id)}`, 'X-O8-Node': id, 'Content-Type': 'application/json' },
    });
    await connect();
    await until(() => seen.find((m) => m.t === 'snapshot'));
    const first = [{ kind: 'five_hour', percentUsed: 10, resetsAt: '2026-10-13T14:30:00Z' }];
    const newer = [{ kind: 'five_hour', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 3 }];
    expect((await post(a.id, { rateLimits: first })).status).toBe(204);
    expect((await post(b.id, { rateLimits: newer })).status).toBe(204);
    expect((await post(a.id, { rateLimits: [] })).status).toBe(204); // no reading: keeps b's
    expect(manager.usage).toMatchObject({ rateLimits: newer, nodeId: b.id });
    const sent = await until(() => { const u = seen.filter((m) => m.t === 'usage'); return u.length === 2 ? u : undefined; });
    expect(sent.map((m) => m.t === 'usage' && m.usage.nodeId)).toEqual([a.id, b.id]);

    // Malformed: rejected, but context and cost from the same report still land on the node.
    expect((await post(a.id, { rateLimits: [{ kind: 'five_hour', percentUsed: 'lots' }], context: { tokens: 5, window: 10, percent: 50 }, cost: { usd: 1 } })).status).toBe(204);
    expect((await post(a.id, { rateLimits: 'nope' })).status).toBe(204);
    expect(manager.usage).toMatchObject({ rateLimits: newer, nodeId: b.id });
    expect(manager.view(a.id)?.status).toMatchObject({ contextPct: 50, costUsd: 1 });

    ws!.terminate();
    seen = [];
    await connect();
    const snap = await until(() => seen.find((m) => m.t === 'snapshot'));
    expect(snap).toMatchObject({ usage: { rateLimits: newer, nodeId: b.id } });
  });

  it('GET /tree: the whole tree from the root, the caller marked self', async () => {
    const root = manager.spawn({ kind: 'terminal', title: 'boss', cwd: tmpdir() });
    const a = manager.spawn({ kind: 'terminal', title: 'a', cwd: tmpdir(), parentId: root.id });
    const a1 = manager.spawn({ kind: 'terminal', title: 'a1', cwd: tmpdir(), parentId: a.id });
    const b = manager.spawn({ kind: 'terminal', title: 'b', cwd: tmpdir(), parentId: root.id });
    manager.spawn({ kind: 'terminal', title: 'elsewhere', cwd: tmpdir() });
    const res = await fetch(`http://127.0.0.1:${server.port}/tree`, { headers: { Authorization: `Bearer ${manager.tokenFor(a.id)}`, 'X-O8-Node': a.id } });
    const rows = await res.json() as Array<{ id: string; depth: number; self?: boolean }>;
    expect(rows.map((r) => [r.id, r.depth, !!r.self])).toEqual([[root.id, 0, false], [a.id, 1, true], [a1.id, 2, false], [b.id, 1, false]]);
  });

  it('X-O8-Clients lists the connected client kinds on /tree and /inbox', async () => {
    const n = manager.spawn({ kind: 'terminal', title: 'boss', cwd: tmpdir() });
    const header = async (path: string) => (await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { Authorization: `Bearer ${manager.tokenFor(n.id)}`, 'X-O8-Node': n.id } })).headers.get('x-o8-clients');
    expect(await header('/tree')).toBe('');
    await connect(adminToken(), 'app');
    await until(() => seen.find((m) => m.t === 'snapshot'));
    expect(await header('/tree')).toBe('app');
    expect(await header('/inbox')).toBe('app');
  });

  it('POST /focus: auth, lineage scope, broadcast', async () => {
    const parent = manager.spawn({ kind: 'terminal', title: 'boss', cwd: tmpdir() });
    const kid = manager.spawn({ kind: 'terminal', title: 'kid', cwd: tmpdir(), parentId: parent.id });
    const other = manager.spawn({ kind: 'terminal', title: 'other', cwd: tmpdir() });
    const focus = (caller: string, token: string, id: string) =>
      fetch(`http://127.0.0.1:${server.port}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-O8-Node': caller }, body: JSON.stringify({ id }) });
    const tp = manager.tokenFor(parent.id), tk = manager.tokenFor(kid.id);
    await connect();
    await until(() => seen.find((m) => m.t === 'snapshot'));
    expect((await focus(parent.id, 'bad', kid.id)).status).toBe(401);
    expect((await focus(parent.id, tp, other.id)).status).toBe(403);
    expect((await focus(kid.id, tk, other.id)).status).toBe(403);
    const cousin = manager.spawn({ kind: 'terminal', title: 'cousin', cwd: tmpdir(), parentId: manager.spawn({ kind: 'terminal', title: 'aunt', cwd: tmpdir(), parentId: parent.id }).id });
    expect((await focus(kid.id, tk, cousin.id)).status).toBe(204); // anywhere in the same tree
    expect((await focus(parent.id, tp, kid.id)).status).toBe(204);
    expect((await focus(kid.id, tk, parent.id)).status).toBe(204); // a child may focus its parent
    await until(() => seen.filter((m) => m.t === 'focus').length === 3 || undefined);
    expect(seen.filter((m) => m.t === 'focus')).toEqual([{ t: 'focus', from: kid.id, id: cousin.id }, { t: 'focus', from: parent.id, id: kid.id }, { t: 'focus', from: kid.id, id: parent.id }]);
  });
});

describe('client tracking', () => {
  it('counts a watcher only while it has the node selected and its window focused; reports the app', async () => {
    await connect(adminToken(), 'app');
    const snap = await until(() => seen.find((m) => m.t === 'snapshot'));
    expect(snap).toMatchObject({ appConnected: true });
    const id = manager.spawn({ kind: 'terminal', title: 'sh', cwd: tmpdir() }).id;
    const watching = (n: number) => until(() => (server.watchers(id) === n ? true : undefined));
    send({ t: 'select', id });
    send({ t: 'visibility', focused: false });
    await new Promise((r) => setTimeout(r, 100));
    expect(server.watchers(id)).toBe(0);
    send({ t: 'visibility', focused: true });
    await watching(1);
    send({ t: 'visibility', focused: false });
    await watching(0);
    ws!.terminate();
    await until(() => (server.appConnected() ? undefined : true));
  });
});
