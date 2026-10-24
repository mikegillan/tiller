import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeManager } from './manager.js';
import { switchMemory } from './memory-config.js';
import type { InjectionView } from './memory-schema.js';
import { startServer, type DaemonServer } from './server.js';

// The memory tools over POST /api/<tool>, as the CLI calls them, with a node's token and the admin token.
let dir: string, home: string, repoA: string, repoB: string, manager: NodeManager, server: DaemonServer;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tl-memtools-')));
  home = join(dir, 'home');
  repoA = join(dir, 'a');
  repoB = join(dir, 'b');
  for (const d of [home, repoA, repoB]) mkdirSync(d);
  execFileSync('git', ['init', '-q', repoA]);
  manager = new NodeManager({ home, shell: '/bin/sh' });
  server = await startServer(manager, { port: 0 });
  vi.spyOn(server.updates, 'start').mockImplementation(() => {});
});

afterEach(async () => {
  await manager.shutdown();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

type Reply = { status: number; text?: string; data?: any; error?: string };
async function api(tool: string, args: object, id = 'human'): Promise<Reply> {
  const token = id === 'human' ? readFileSync(join(home, 'admin-token'), 'utf8') : manager.tokenFor(id);
  const res = await fetch(`http://127.0.0.1:${server.port}/api/${tool}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-TL-Node': id }, body: JSON.stringify(args) });
  return { status: res.status, ...(await res.json()) };
}
/** An agent node in `cwd`: a terminal relabelled, so no harness runs. */
async function agent(cwd: string, title = 'w'): Promise<string> {
  const id = (await api('spawn', { kind: 'terminal', title, cwd })).data.nodeId as string;
  manager.registry.update(id, { kind: 'claude' });
  return id;
}
const on = () => switchMemory(home, {}, 'on');
const memoryDir = () => join(home, 'memory');

describe('memory tools', () => {
  it('are off by default with the source, create nothing, and memory_switch turns them on', async () => {
    const a = await agent(repoA);
    const off = await api('memory_search', { query: 'anything' }, a);
    expect(off.status).toBe(400);
    expect(off.error).toBe(`memory is off for this project (default); the human can turn it on with \`tl memory on --project ${repoA}\``);
    expect((await api('memory_add', { kind: 'note', text: 'x' }, a)).error).toMatch(/^memory is off/);
    expect((await api('memory_search', { query: 'x', repo: repoA })).error).toMatch(/^memory is off/);
    const status = await api('memory_status', { nodeId: a });
    expect(status.data).toMatchObject({ memory: { on: false, source: 'default' }, dbs: [], injections: [] });
    expect(existsSync(memoryDir())).toBe(false);

    const sw = await api('memory_switch', { on: true, project: repoA });
    expect(sw.data).toEqual({ on: true, source: `memory.projects ${repoA} in ${join(home, 'config.json')}` });
    expect(sw.text).toContain('memory is now on');
    const added = await api('memory_add', { kind: 'procedure', text: 'npm test -- src/x.test.ts passes' }, a);
    expect(added.data).toEqual({ id: 1 });
    expect((await api('memory_search', { query: 'npm test' }, a)).text).toMatch(new RegExp(`^m1 · procedure · \\w+ · ${a} claude · npm test`));
    // repoB has no entry: still off there.
    expect((await api('memory_search', { query: 'npm' }, await agent(repoB, 'b'))).error).toMatch(/^memory is off for this project \(default\)/);

    expect((await api('memory_switch', { on: null, project: repoA })).data.on).toBe(false);
    expect((await api('memory_switch', { on: true, project: 'relative/path' })).error).toMatch(/absolute path/);
    expect((await api('memory_switch', { on: true, project: repoA, account: 'x' })).error).toMatch(/not both/);
  });

  it('refuse agents memory_switch, memory_pin, memory_status, purge, repo and account, and pinned items', async () => {
    on();
    const a = await agent(repoA);
    for (const [tool, args] of [['memory_switch', { on: true }], ['memory_pin', { text: 'always run lint' }], ['memory_status', {}]] as const) {
      expect((await api(tool, args, a)).error).toBe(`${tool} is only for the human`);
    }
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).memory).toEqual({ enabled: true });
    const own = (await api('memory_add', { kind: 'note', text: 'mine' }, a)).data.id as number;
    expect((await api('memory_forget', { id: `m${own}`, reason: 'r', purge: true }, a)).error).toBe('refused: only the human can purge');
    for (const scope of [{ repo: repoB }, { account: 'work' }]) {
      expect((await api('memory_search', { query: 'mine', ...scope }, a)).error).toMatch(/^refused: repo and account are the human's/);
      expect((await api('memory_add', { kind: 'note', text: 'elsewhere', ...scope }, a)).error).toMatch(/^refused/);
    }
    const pin = (await api('memory_pin', { text: 'Never push to main', repo: repoA })).data;
    expect(pin).toMatchObject({ author: 'human', pinned: true, text: 'Never push to main' });
    expect((await api('memory_forget', { id: `m${pin.id}`, reason: 'nope' }, a)).error).toMatch(/is pinned/);
    expect((await api('memory_add', { kind: 'note', text: 'better', supersedes: `m${pin.id}` }, a)).error).toMatch(/is pinned/);
    // The agent's actor is its node: the retraction is an agent's, by that node.
    expect((await api('memory_forget', { id: `m${own}`, reason: 'stale' }, a)).data.invalid).toMatchObject({ kind: 'agent', by: a, reason: 'stale' });
    expect((await api('memory_get', { id: `m${pin.id}` }, a)).text).toMatch(/pinned by the human · recorded by the human/);
  });

  it('memory_status { nodeId } returns its injections as InjectionView data, oldest first', async () => {
    on();
    const a = await agent(repoA);
    const scope = manager.memoryScope(a)!;
    manager.memory.recordInjection(scope, { sessionId: 's-1', arm: 'on', cause: 'config', itemIds: [1, 2], text: '# Memory\n...' });
    manager.memory.recordInjection(scope, { sessionId: 's-1', arm: 'on', cause: 'resume', itemIds: [], text: '' });
    const r = await api('memory_status', { nodeId: a, days: 30 });
    expect(r.status).toBe(200);
    const injections: InjectionView[] = r.data.injections;
    expect(injections).toEqual([
      { sessionId: 's-1', arm: 'on', cause: 'config', itemIds: [1, 2], text: '# Memory\n...', ts: expect.any(Number) },
      { sessionId: 's-1', arm: 'on', cause: 'resume', itemIds: [], text: '', ts: expect.any(Number) },
    ]);
    expect(r.data.memory).toEqual({ on: true, source: `memory.enabled in ${join(home, 'config.json')}` });
    expect(r.data.dbs).toMatchObject([{ key: '_default', state: 'ok', schema: 1 }]);
    expect(r.data.arms.on.nodes).toBe(1);
    expect(r.text).toContain(`injections of ${a}: 2`);
  });

  it('hides another repository\'s items: get, forget and search see no such item', async () => {
    on();
    const a = await agent(repoA, 'a'), b = await agent(repoB, 'b');
    const id = (await api('memory_add', { kind: 'pitfall', text: 'secret plans fail on Fridays' }, a)).data.id as number;
    expect((await api('memory_get', { id: `m${id}` }, b)).error).toBe(`no such item m${id}`);
    expect((await api('memory_forget', { id: `m${id}`, reason: 'x' }, b)).error).toBe(`no such item m${id}`);
    expect((await api('memory_search', { query: 'secret plans' }, b)).data).toEqual([]);
    expect((await api('memory_get', { id: `m${id}`, repo: repoB })).error).toBe(`no such item m${id}`);
    expect((await api('memory_get', { id: 'm99999999999999999' }, a)).status).toBe(400); // past the ref pattern
    expect((await api('memory_get', { id: `m${id}` }, a)).data).toMatchObject({ id, text: 'secret plans fail on Fridays', gets: 1 });
  });

  it('caps an agent at 20 adds; the human is not capped', async () => {
    on();
    const a = await agent(repoA);
    for (let i = 0; i < 20; i++) expect((await api('memory_add', { kind: 'note', text: `note number ${i}` }, a)).status).toBe(200);
    expect((await api('memory_add', { kind: 'note', text: 'one too many' }, a)).error).toBe('memory_add is limited to 20 per node');
    expect((await api('memory_add', { kind: 'note', text: 'the human adds', repo: repoA })).status).toBe(200);
    expect((await api('memory_add', { kind: 'ledger', text: 'x' }, a)).status).toBe(400); // not an add kind
    expect((await api('memory_add', { kind: 'note', text: 'x'.repeat(301) }, a)).status).toBe(400);
  });

  it('returns results for hostile queries, which never reach FTS5 as syntax', async () => {
    on();
    const a = await agent(repoA);
    await api('memory_add', { kind: 'pitfall', text: 'vitest watch mode hangs in CI' }, a);
    for (const query of ['"vitest" OR NEAR(watch', 'vitest*', '-vitest ^hangs', 'col:vitest AND (', "vitest'; DROP TABLE items; --", 'watch\u0000mode']) {
      const r = await api('memory_search', { query }, a);
      expect(r.status, query).toBe(200);
      expect(r.data.map((v: { text: string }) => v.text), query).toEqual(['vitest watch mode hangs in CI']);
    }
    expect((await api('memory_search', { query: '"*" ( ) :' }, a)).data).toEqual([]);
  });

  it('the human names the repository by a directory in it, defaulting the account by project', async () => {
    on();
    const a = await agent(repoA);
    const id = (await api('memory_add', { kind: 'note', text: 'from the agent' }, a)).data.id as number;
    expect((await api('memory_get', { id: `m${id}` })).error).toMatch(/^repo is required for the human/);
    expect((await api('memory_get', { id: `m${id}`, repo: 'a' })).error).toMatch(/^repo must be the absolute path of a directory/);
    // A subdirectory of the agent's checkout is the same repository.
    const sub = join(repoA, 'src');
    mkdirSync(sub);
    expect((await api('memory_get', { id: `m${id}`, repo: sub })).data).toMatchObject({ id, nodeId: a, author: 'agent' });
    const mine = await api('memory_add', { kind: 'note', text: 'from the human', repo: sub });
    expect((await api('memory_search', { query: 'human' }, a)).data).toMatchObject([{ id: mine.data.id, author: 'human' }]);
    // The human's forget is sticky; purge leaves a tombstone.
    expect((await api('memory_forget', { id: `m${id}`, reason: 'wrong', purge: true, repo: repoA })).data).toMatchObject({ tombstone: 'purged', text: '' });
    // A named account not in claude.accounts fails closed.
    expect((await api('memory_search', { query: 'x', repo: repoA, account: 'nope' })).error).toMatch(/^memory is off for this project \(Claude account "nope" is not configured/);
  });
});
