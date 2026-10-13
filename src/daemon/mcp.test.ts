import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemPrompt } from './launch.js';
import { NodeManager } from './manager.js';
import { mountMcp } from './mcp.js';
import { inbox } from './messaging.js';

let home = '', manager: NodeManager, server: http.Server, base = '', admin = '';
const confirms: string[] = [];
let answer = true;
const focused: string[][] = [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'o8-mcp-'));
  manager = new NodeManager({ home, shell: '/bin/sh' });
  const { handler, publishAdminToken } = mountMcp(manager, async (t) => { confirms.push(t); return answer; }, (from, id) => focused.push([from, id]));
  expect(() => readFileSync(join(home, 'admin-token'))).toThrow(); // not written until the server is listening
  server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  publishAdminToken();
  admin = readFileSync(join(home, 'admin-token'), 'utf8');
});
afterAll(async () => {
  manager.shutdown();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(home, { recursive: true, force: true });
});

const api = async (tool: string, args: object, id = 'human', token = admin) => {
  const res = await fetch(`${base}/api/${tool}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-O8-Node': id }, body: JSON.stringify(args) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { text?: string; data?: any; error?: string } };
};
const spawnT = (title: string, id = 'human', token = admin, extra = {}) => api('spawn', { kind: 'terminal', title, cwd: tmpdir(), ...extra }, id, token);

describe('mcp api', () => {
  it('keeps the admin token across daemon starts on the same home', () => {
    mountMcp(manager, async () => true, () => {}).publishAdminToken();
    expect(readFileSync(join(home, 'admin-token'), 'utf8')).toBe(admin);
  });
  it('rejects missing or wrong credentials', async () => {
    expect((await api('list_nodes', {}, 'human', 'nope')).status).toBe(401);
    expect((await api('list_nodes', {}, 'n-ghost', manager.tokenFor('n-ghost'))).status).toBe(401);
  });

  it('spawn is idempotent per requestId and parents the node to the caller', async () => {
    const a = await spawnT('parent', 'human', admin, { requestId: 'r1' });
    const id = a.body.data.nodeId as string;
    expect((await spawnT('parent', 'human', admin, { requestId: 'r1' })).body.data).toEqual({ nodeId: id, replayed: true });
    expect((await spawnT('other', 'human', admin, { requestId: 'r1' })).status).toBe(400);
    const child = (await spawnT('kid', id, manager.tokenFor(id))).body.data.nodeId as string;
    expect(manager.view(child)?.parentId).toBe(id);
    const list = (await api('list_nodes', {})).body;
    expect(list.text).toContain(`  - ${child} "kid"`);
    expect(list.text?.split('\n')[0]).toBe('usage: no report yet');
    expect(list.data.find((n: any) => n.id === child)).toMatchObject({ parentId: id, kind: 'terminal', flags: [] });
    manager.registry.update(id, { spentUsd: 1 });
    manager.registry.update(child, { spentUsd: 2 });
    const spent = (await api('list_nodes', {})).body;
    expect(spent.data.find((n: any) => n.id === id)).toMatchObject({ spentUsd: 1, subtreeSpentUsd: 3 });
    expect(spent.text).toContain(`- ${id} "parent" [terminal] none now · $1.00 (tree $3.00)`);
  });

  it('refuses to close an orchestrator unless the human forces it; restart is human-only', async () => {
    const root = (await spawnT('root')).body.data.nodeId as string;
    const kid = (await spawnT('kid', root, manager.tokenFor(root))).body.data.nodeId as string;
    const tok = (id: string) => manager.tokenFor(id);
    expect((await api('close', { nodeIds: [root] }, kid, tok(kid))).body.error).toMatch(/descendants/); // a child cannot reach its parent
    expect((await api('close', { nodeIds: [root] }, root, tok(root))).body.error).toMatch(/descendants/); // nor itself
    expect((await api('close', { nodeIds: [root], force: true }, kid, tok(kid))).status).toBe(400);
    expect((await api('close', { nodeIds: [root] })).body.error).toBe(`refusing to close an orchestrator; use o8 kill --force ${root}`);
    expect(manager.view(root)).toBeDefined();
    expect((await api('restart', { nodeId: root }, kid, tok(kid))).body.error).toMatch(/only for the human/);
    expect((await api('restart', { nodeId: root })).body.data).toEqual({ ok: true });
    expect(manager.view(kid)!.parentId).toBe(root);
    expect((await api('close', { nodeIds: [root], force: true })).body.data).toMatchObject({ ok: true });
    expect(manager.view(root)).toBeUndefined();
  });

  it('enforces read scope and descendant-only close, with one confirm per batch', async () => {
    const p = (await spawnT('p2')).body.data.nodeId as string;
    const c1 = (await spawnT('c1', p, manager.tokenFor(p))).body.data.nodeId as string;
    const c2 = (await spawnT('c2', p, manager.tokenFor(p))).body.data.nodeId as string;
    const stranger = (await spawnT('stranger')).body.data.nodeId as string;
    const tok = (id: string) => manager.tokenFor(id);
    expect((await api('read', { nodeId: c2, what: 'terminal', lines: 3 }, c1, tok(c1))).status).toBe(200); // sibling
    expect((await api('read', { nodeId: stranger, what: 'terminal' }, c1, tok(c1))).status).toBe(400);
    expect((await api('close', { nodeIds: [c1, stranger] }, p, tok(p))).body.error).toMatch(/descendants/);
    expect(manager.view(c1)).toBeDefined(); // whole batch refused
    confirms.length = 0;
    expect((await api('close', { nodeIds: [c1, c2] }, p, tok(p))).body.data).toMatchObject({ ok: true });
    expect(confirms).toHaveLength(1);
    expect(manager.view(c1)).toBeUndefined();
    answer = false;
    const c3 = (await spawnT('c3', p, manager.tokenFor(p))).body.data.nodeId as string;
    expect((await api('write', { nodeId: c3, text: 'ls\r' }, p, tok(p))).body.data).toEqual({ ok: false, reason: 'denied' });
    answer = true;
  });

  it('closeWithoutConfirm in the caller\'s project config skips the confirm only as configured', async () => {
    const proj = join(home, 'proj');
    mkdirSync(join(proj, '.orchestr8'), { recursive: true });
    const setMode = (mode: string) => writeFileSync(join(proj, '.orchestr8', 'config.json'), JSON.stringify({ closeWithoutConfirm: mode }));
    const p = (await spawnT('cfg', 'human', admin, { cwd: proj })).body.data.nodeId as string;
    const tok = manager.tokenFor(p);
    const kids = async (n: number) => Promise.all(Array.from({ length: n }, async () => (await spawnT('k', p, tok)).body.data.nodeId as string));
    const close = async (ids: string[]) => { confirms.length = 0; await api('close', { nodeIds: ids }, p, tok); return confirms.length; };
    setMode('done');
    const [a, b] = await kids(2);
    for (const id of [a, b]) manager.applyHook(id, { hook_event_name: 'Stop' });
    expect(await close([a, b])).toBe(0);
    expect(manager.view(a)).toBeUndefined();
    const [c, d] = await kids(2);
    manager.applyHook(c, { hook_event_name: 'Stop' });
    manager.applyHook(d, { hook_event_name: 'UserPromptSubmit' }); // working
    expect(await close([c, d])).toBe(1);
    const [f] = await kids(1);
    manager.applyHook(f, { hook_event_name: 'UserPromptSubmit' }); // still working, but it has reported its outcome
    await api('report_outcome', { outcome: 'succeeded' }, f, manager.tokenFor(f));
    expect(await close([f])).toBe(0);
    setMode('never');
    const [e] = await kids(1);
    manager.applyHook(e, { hook_event_name: 'Stop' });
    expect(await close([e])).toBe(1);
    setMode('always');
    const [g] = await kids(1);
    expect(await close([g])).toBe(0);
  });

  it('only the human may spawn with bypassPermissions; the mode is validated', async () => {
    const p = (await spawnT('bp')).body.data.nodeId as string;
    const args = { kind: 'terminal', title: 'k', cwd: tmpdir(), permissionMode: 'bypassPermissions' };
    expect((await api('spawn', args, p, manager.tokenFor(p))).body.error).toMatch(/only the human/);
    expect((await api('spawn', args)).status).toBe(200);
    expect((await api('spawn', { ...args, permissionMode: 'yolo' })).status).toBe(400);
  });

  it('spawn inherits the caller\'s observed permission mode; bypassPermissions is never inherited', async () => {
    const p = (await spawnT('pm')).body.data.nodeId as string;
    const tok = manager.tokenFor(p);
    const mode = async (extra = {}) => manager.registry.get((await spawnT('k', p, tok, extra)).body.data.nodeId)?.permissionMode;
    expect(await mode()).toBeUndefined();
    manager.applyHook(p, { hook_event_name: 'UserPromptSubmit', permission_mode: 'auto' });
    expect(await mode()).toBe('auto');
    expect(await mode({ permissionMode: 'default' })).toBe('default');
    manager.applyHook(p, { hook_event_name: 'UserPromptSubmit', permission_mode: 'bypassPermissions' });
    expect(await mode()).toBeUndefined();
    expect(manager.registry.get(p)?.permissionMode).toBe('bypassPermissions'); // recorded for resume
  });

  it('list_nodes shows a node only its lineage; write is capped at 2000 characters', async () => {
    const p = (await spawnT('lp')).body.data.nodeId as string;
    const c = (await spawnT('lc', p, manager.tokenFor(p))).body.data.nodeId as string;
    const stranger = (await spawnT('ls')).body.data.nodeId as string;
    const ids = (await api('list_nodes', {}, c, manager.tokenFor(c))).body.data.map((n: any) => n.id);
    expect(ids).toContain(p);
    expect(ids).toContain(c);
    expect(ids).not.toContain(stranger);
    const long = await api('write', { nodeId: p, text: 'x'.repeat(2001) }, c, manager.tokenFor(c));
    expect(long.status).toBe(400);
    expect(long.body.error).toMatch(/2000/);
    confirms.length = 0;
    await api('write', { nodeId: p, text: 'y'.repeat(1500) }, c, manager.tokenFor(c));
    expect(confirms[0]).toContain('y'.repeat(1500));
  });

  it('select is human only and announces a focus for an existing node', async () => {
    const id = (await spawnT('sel')).body.data.nodeId as string;
    expect((await api('select', { nodeId: id }, id, manager.tokenFor(id))).status).toBe(400);
    expect((await api('select', { nodeId: 'nope' })).status).toBe(400);
    expect(focused).toEqual([]);
    expect((await api('select', { nodeId: id })).status).toBe(200);
    expect(focused).toEqual([['human', id]]);
  });

  it('report_outcome stores the structured fields and list_nodes returns them; no gate configured records at once', async () => {
    const p = (await spawnT('rp')).body.data.nodeId as string;
    const w = (await spawnT('rw', p, manager.tokenFor(p))).body.data.nodeId as string;
    const report = { outcome: 'succeeded', note: 'n', summary: 'did it', changedFiles: ['a.ts', 'b.ts'], verified: 'vitest: 3 passed', openQuestions: ['keep b?'] };
    expect((await api('report_outcome', report, w, manager.tokenFor(w))).body.data).toEqual({ ok: true });
    const list = (await api('list_nodes', {}, p, manager.tokenFor(p))).body;
    expect(list.data.find((n: any) => n.id === w).outcome).toMatchObject(report);
    expect(list.text).toContain('reported succeeded');
  });

  describe('completion gate', () => {
    const proj = () => join(home, 'gated');
    const tok = (id: string) => manager.tokenFor(id);
    beforeAll(() => {
      mkdirSync(join(proj(), '.orchestr8'), { recursive: true });
      writeFileSync(join(proj(), '.orchestr8', 'config.json'), JSON.stringify({ gate: { command: 'test -f ok.txt && echo fine || { echo missing ok.txt; exit 3; }', retries: 1 }, limits: { maxLiveNodes: 100 } })); // earlier tests leave many nodes live
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [proj()]: { hasTrustDialogAccepted: true } } })); // gate commands need trust, as setup does
      vi.stubEnv('HOME', home);
    });
    afterAll(() => vi.unstubAllEnvs());
    /** A parent and a worker in the gated project, both "claude" with a polling mod so the daemon's messages land in their inboxes. */
    const pair = async () => {
      const p = (await spawnT('gp', 'human', admin, { cwd: proj() })).body.data.nodeId as string;
      const w = (await spawnT('gw', p, tok(p), { cwd: proj() })).body.data.nodeId as string;
      for (const id of [p, w]) { manager.registry.update(id, { kind: 'claude' }); inbox(manager, id); }
      return { p, w };
    };

    it('records a passing gate with gate: passed', async () => {
      writeFileSync(join(proj(), 'ok.txt'), '');
      const { w } = await pair();
      const r = await api('report_outcome', { outcome: 'succeeded', summary: 's' }, w, tok(w));
      expect(r.body.data).toEqual({ ok: true, gate: 'passed' });
      expect(manager.view(w)).toMatchObject({ gate: 'passed', outcome: { outcome: 'succeeded', summary: 's', gate: 'passed' } });
      expect(readFileSync(join(home, 'nodes', w, 'gate.log'), 'utf8')).toContain('fine');
      rmSync(join(proj(), 'ok.txt'));
    });

    it('a failing gate messages the worker without recording; the last failure records failed and tells the parent', async () => {
      const { p, w } = await pair();
      const first = await api('report_outcome', { outcome: 'succeeded' }, w, tok(w));
      expect(first.body.data).toEqual({ ok: false, gate: 'failed', attemptsLeft: 1 });
      expect(manager.view(w)!.outcome).toBeUndefined();
      expect(manager.view(w)!.gate).toBe('failed');
      const [msg] = inbox(manager, w);
      expect(msg.text).toContain('Completion gate failed (attempt 1 of 2): test -f ok.txt');
      expect(msg.text).toContain('missing ok.txt');
      expect(msg.text).toContain('exited with 3');
      expect(msg.text).toContain('Fix it and call report_outcome again.');
      expect(inbox(manager, p)).toEqual([]);
      const last = await api('report_outcome', { outcome: 'succeeded', summary: 's' }, w, tok(w));
      expect(last.body.data).toEqual({ ok: false, gate: 'failed', attemptsLeft: 0 });
      expect(manager.view(w)!.outcome).toMatchObject({ outcome: 'failed', gate: 'failed', summary: 's' });
      const [notice] = inbox(manager, p);
      expect(notice.text).toContain(`failed its completion gate`);
      expect(notice.text).toContain('attempt 2 of 2');
    });
  });

  it('serves the tools over MCP with schemas', async () => {
    const id = (await spawnT('mcp-caller')).body.data.nodeId as string;
    const client = new Client({ name: 't', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${manager.tokenFor(id)}`, 'X-O8-Node': id } } }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['close', 'diff', 'list_nodes', 'merge', 'message_status', 'prune', 'read', 'rename', 'report_outcome', 'restart', 'resume', 'select', 'send', 'shutdown', 'spawn', 'withdraw', 'worktrees', 'write']);
    expect(tools.find((t) => t.name === 'spawn')!.inputSchema.required).toEqual(['kind', 'title', 'cwd']);
    const r = (await client.callTool({ name: 'report_outcome', arguments: { outcome: 'succeeded' } })) as { content: Array<{ text: string }> };
    expect(r.content[0].text).toBe('{"ok":true}');
    await client.close();
  });
});

describe('systemPrompt', () => {
  it('states identity and framing rules', () => {
    const p = systemPrompt({ nodeId: 'n-1', title: 'Builder', parentId: null, home: '/nonexistent', cwd: '/nonexistent' });
    expect(p).toContain('node n-1');
    expect(p).toContain('parent node is none');
    expect(p).toContain('--- O8 MESSAGE <nonce> ---');
    expect(p).toContain('OUTERMOST');
  });
});
