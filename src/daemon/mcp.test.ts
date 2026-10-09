import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemPrompt } from './launch.js';
import { NodeManager } from './manager.js';
import { mountMcp } from './mcp.js';

let home = '', manager: NodeManager, server: http.Server, base = '', admin = '';
const confirms: string[] = [];
let answer = true;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'o8-mcp-'));
  manager = new NodeManager({ home, shell: '/bin/sh' });
  const handler = mountMcp(manager, async (t) => { confirms.push(t); return answer; });
  server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
    expect(list.data.find((n: any) => n.id === child)).toMatchObject({ parentId: id, kind: 'terminal', flags: [] });
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

  it('serves the tools over MCP with schemas', async () => {
    const id = (await spawnT('mcp-caller')).body.data.nodeId as string;
    const client = new Client({ name: 't', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${manager.tokenFor(id)}`, 'X-O8-Node': id } } }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['close', 'list_nodes', 'message_status', 'read', 'rename', 'report_outcome', 'send', 'spawn', 'write']);
    expect(tools.find((t) => t.name === 'spawn')!.inputSchema.required).toEqual(['kind', 'title', 'cwd']);
    const r = (await client.callTool({ name: 'report_outcome', arguments: { outcome: 'succeeded' } })) as { content: Array<{ text: string }> };
    expect(r.content[0].text).toBe('{"ok":true}');
    await client.close();
  });
});

describe('systemPrompt', () => {
  it('states identity, framing rules and stays under 250 words', () => {
    const p = systemPrompt({ nodeId: 'n-1', title: 'Builder', parentId: null });
    expect(p).toContain('node n-1');
    expect(p).toContain('parent node is none');
    expect(p).toContain('--- O8 MESSAGE <nonce> ---');
    expect(p).toContain('OUTERMOST');
    expect(p.split(/\s+/).length).toBeLessThan(250);
  });
});
