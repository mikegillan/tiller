import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchArgs } from './launch.js';
import { NodeManager, trustPolicy } from './manager.js';

describe('trustPolicy', () => {
  const json = { projects: { '/work/repo': { hasTrustDialogAccepted: true }, '/work/no': { hasTrustDialogAccepted: false } } };
  it.each([
    ['/work/repo', json, 'auto'],            // exact match
    ['/work/repo/sub/dir', json, 'auto'],    // ancestor is trusted
    ['/work/no', json, 'manual'],            // explicitly not accepted
    ['/work/other', json, 'manual'],         // unknown
    ['/work', json, 'manual'],               // a parent of a trusted dir is not trusted
    ['/work/repo', { projects: { '/': { hasTrustDialogAccepted: true } } }, 'auto'], // root trusted
    ['/work/repo', {}, 'manual'],
    ['/work/repo', null, 'manual'],
  ])('%s -> %s', (cwd, cfg, want) => {
    expect(trustPolicy(cwd, cfg)).toBe(want);
  });
});

describe('NodeManager tokens and files', () => {
  let home = '';
  let m: NodeManager;
  afterEach(() => { m.shutdown(); rmSync(home, { recursive: true, force: true }); });

  it('verifies per-node tokens and keeps the secret private', () => {
    home = mkdtempSync(join(tmpdir(), 'o8-'));
    m = new NodeManager({ home });
    const t = m.tokenFor('n-1');
    expect(m.verifyToken('n-1', t)).toBe(true);
    expect(m.verifyToken('n-2', t)).toBe(false);
    expect(m.verifyToken('n-1', t.slice(0, -1))).toBe(false);
    expect(m.verifyToken('n-1', '')).toBe(false);
    expect(statSync(join(home, 'secret')).mode & 0o777).toBe(0o600);
    // A second manager on the same home derives the same tokens.
    const m2 = new NodeManager({ home });
    expect(m2.verifyToken('n-1', t)).toBe(true);
    m2.shutdown();
  });

  it('writes node files with restrictive modes and removes them on close', async () => {
    home = mkdtempSync(join(tmpdir(), 'o8-'));
    m = new NodeManager({ home, shell: '/bin/sh' });
    const n = m.spawn({ kind: 'terminal', title: 't', cwd: tmpdir() });
    const dir = join(home, 'nodes', n.id);
    expect(statSync(join(dir, 'token')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'mcp.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'hook-headers')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'settings.json')).isFile()).toBe(true);
    await expect(m.close(n.id)).rejects.toThrow(/orchestrator/);
    await m.close(n.id, true);
    expect(() => statSync(dir)).toThrow();
    expect(m.list()).toEqual([]);
  });

  it('cleans up when the cwd is bad', () => {
    home = mkdtempSync(join(tmpdir(), 'o8-'));
    m = new NodeManager({ home, shell: '/bin/sh' });
    expect(() => m.spawn({ kind: 'terminal', title: 't', cwd: '/no/such/dir' })).toThrow(/working directory/);
    expect(m.list()).toEqual([]);
  });
});

describe('NodeManager restart', () => {
  let home = '';
  let m: NodeManager;
  afterEach(() => { m.shutdown(); rmSync(home, { recursive: true, force: true }); });

  it('relaunches a terminal node with a new process, same id, children kept; refuses to close a root; prune keeps a live root', async () => {
    home = mkdtempSync(join(tmpdir(), 'o8-'));
    m = new NodeManager({ home, shell: '/bin/sh' });
    const root = m.spawn({ kind: 'terminal', title: 'root', cwd: tmpdir() });
    const kid = m.spawn({ kind: 'terminal', title: 'kid', cwd: tmpdir(), parentId: root.id });
    const pid = m.session(root.id)!.pid;
    expect(m.restart(root.id)).toEqual({ ok: true });
    expect(m.session(root.id)!.pid).not.toBe(pid);
    expect(m.view(root.id)).toMatchObject({ id: root.id, parentId: null, title: 'root', status: { activity: 'restarting' } });
    expect(m.view(kid.id)!.parentId).toBe(root.id);
    expect(m.restart('nope')).toMatchObject({ ok: false });
    await expect(m.close(root.id)).rejects.toThrow(/orchestrator/);
    await m.close(kid.id); // a child closes without force
    expect(await m.prune()).toEqual({ removed: [], kept: [] });
    expect(m.view(root.id)).toBeDefined();
  });

  it('gives a Claude node a new session id and keeps at most 10 old ones', () => {
    home = mkdtempSync(join(tmpdir(), 'o8-'));
    m = new NodeManager({ home, shell: '/bin/sh' });
    // A missing cwd makes the launch fail without starting claude; the record and launch arguments are what is under test.
    const id = m.registry.create({ parentId: null, kind: 'claude', title: 'c', cwd: '/no/such/dir', sessionId: 's0' }).id;
    const first = new Set<string>();
    for (let i = 0; i < 12; i++) { expect(m.restart(id)).toMatchObject({ ok: false }); first.add(m.registry.get(id)!.sessionId!); }
    const rec = m.registry.get(id)!;
    const args = launchArgs({ nodeId: id, nodeDir: '/tmp/n', endpoint: 'http://x', path: '', title: 'c', parentId: null, home, cwd: rec.cwd, sessionId: rec.sessionId! });
    expect(args.slice(0, 2)).toEqual(['--session-id', rec.sessionId]);
    expect(args).not.toContain('s0');
    expect(first.size).toBe(12);
    expect(rec.sessionId).not.toBe('s0');
    expect(rec.previousSessions).toHaveLength(10);
    expect(rec.previousSessions!.at(-1)).toBe([...first][10]);
  });
});

describe('NodeManager model and effort defaults', () => {
  let home = '';
  let m: NodeManager;
  afterEach(() => { m.shutdown(); rmSync(home, { recursive: true, force: true }); });

  it('records the configured model for the role unless spawn passes one; project beats home', () => {
    home = mkdtempSync(join(tmpdir(), 'o8-'));
    const bin = join(home, 'bin'), proj = join(home, 'proj');
    mkdirSync(bin);
    mkdirSync(join(proj, '.orchestr8'), { recursive: true });
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nsleep 5\n'); // stands in for claude so nothing real launches
    chmodSync(join(bin, 'claude'), 0o755);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ roles: { orchestrator: { model: 'opus' }, worker: { model: 'sonnet' } } }));
    writeFileSync(join(proj, '.orchestr8', 'config.json'), JSON.stringify({ roles: { worker: { model: 'haiku' } } }));
    m = new NodeManager({ home, shell: '/bin/sh', path: `${bin}:/usr/bin:/bin` });
    const model = (req: { parentId?: string; model?: string; role?: 'none' }) => m.registry.get(m.spawn({ kind: 'claude', title: 'c', cwd: proj, ...req }).id)!.model;
    const root = m.spawn({ kind: 'claude', title: 'root', cwd: proj });
    expect(m.registry.get(root.id)!.model).toBe('opus');        // orchestrator: home file
    expect(model({ parentId: root.id })).toBe('haiku');         // worker: project file
    expect(model({ role: 'none' })).toBe('haiku');              // none counts as worker
    expect(model({ parentId: root.id, model: 'x' })).toBe('x'); // explicit spawn argument
    expect(m.registry.get(m.spawn({ kind: 'terminal', title: 't', cwd: proj }).id)!.model).toBeUndefined();
  });

  it('resolves effort from spawn, then the project file, then the home file, and passes it to claude as --effort', async () => {
    home = mkdtempSync(join(tmpdir(), 'o8-'));
    const bin = join(home, 'bin'), proj = join(home, 'proj'), other = join(home, 'other');
    mkdirSync(bin);
    mkdirSync(join(proj, '.orchestr8'), { recursive: true });
    mkdirSync(other);
    // Fake claude: writes its argv next to the node's settings.json, then idles.
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nfor a in "$@"; do case "$prev" in --settings) out="$(dirname "$a")/argv";; esac; prev="$a"; done\necho "$@" > "$out"\nsleep 5\n');
    chmodSync(join(bin, 'claude'), 0o755);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ roles: { orchestrator: { effort: 'max' }, worker: { effort: 'high' } } }));
    writeFileSync(join(proj, '.orchestr8', 'config.json'), JSON.stringify({ roles: { worker: { effort: 'low' } } }));
    m = new NodeManager({ home, shell: '/bin/sh', path: `${bin}:/usr/bin:/bin` });
    const root = m.spawn({ kind: 'claude', title: 'root', cwd: proj });
    const spawn = (req: { cwd?: string; effort?: 'medium' }) => m.registry.get(m.spawn({ kind: 'claude', title: 'c', cwd: proj, parentId: root.id, ...req }).id)!;
    expect(m.registry.get(root.id)!.effort).toBe('max');            // orchestrator: home file
    const fromProject = spawn({});
    expect(fromProject.effort).toBe('low');                          // worker: project beats home
    expect(spawn({ cwd: other }).effort).toBe('high');               // no project file: home
    expect(spawn({ effort: 'medium' }).effort).toBe('medium');       // explicit spawn argument
    const argvFile = join(home, 'nodes', fromProject.id, 'argv');
    await expect.poll(() => { try { return readFileSync(argvFile, 'utf8'); } catch { return ''; } }).toContain('--effort low');
  });
});

describe('NodeManager live set and resume on start', () => {
  let home = '';
  let m: NodeManager;
  afterEach(() => { m.shutdown(); rmSync(home, { recursive: true, force: true }); });
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).live;

  it('saves the live ids as processes start and exit, keeps them on shutdown and clears them on an explicit stop', async () => {
    home = mkdtempSync(join(tmpdir(), 'o8-'));
    m = new NodeManager({ home, shell: '/bin/sh' });
    const a = m.spawn({ kind: 'terminal', title: 'a', cwd: tmpdir() });
    const b = m.spawn({ kind: 'terminal', title: 'b', cwd: tmpdir(), parentId: a.id });
    await expect.poll(saved).toEqual([a.id, b.id]);
    process.kill(m.session(b.id)!.pid, 'SIGKILL');
    await expect.poll(saved).toEqual([a.id]);
    m.shutdown(); // like SIGTERM: the set survives the PTYs' exits
    await new Promise((r) => setTimeout(r, 200));
    expect(saved()).toEqual([a.id]);
    m = new NodeManager({ home, shell: '/bin/sh' });
    m.shutdown({ clearLive: true }); // o8 stop
    expect(saved()).toEqual([]);
  });

  it('resumes live Claude nodes parents first, skipping missing, idle and worktree-less ones, then forgets the set', async () => {
    home = mkdtempSync(join(tmpdir(), 'o8-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nsleep 5\n'); // stands in for claude
    chmodSync(join(bin, 'claude'), 0o755);
    const transcript = join(home, 't.jsonl');
    writeFileSync(transcript, '');
    const now = Date.now(), day = 86_400_000;
    const rec = (id: string, parentId: string | null, extra = {}) => ({ id, parentId, kind: 'claude', title: id, cwd: home, createdAt: now - 30 * day, lastActiveAt: now, sessionId: `s-${id}`, transcriptPath: transcript, ...extra });
    const nodes = [
      rec('kid', 'root'), rec('root', null), rec('idle', 'root', { lastActiveAt: now - 4 * day }),
      rec('nowt', 'root', { worktree: { repo: home, path: join(home, 'gone'), branch: 'o8/nowt', base: 'main', baseSha: 'x' } }),
      rec('exited', 'root'), // not in the live set
    ];
    writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, nodes, live: ['kid', 'root', 'idle', 'nowt', 'deleted'] }));
    m = new NodeManager({ home, shell: '/bin/sh', path: `${bin}:/usr/bin:/bin` });
    const order: string[] = [];
    const resume = m.resume.bind(m);
    m.resume = (id) => { order.push(id); return resume(id); };
    expect(await m.resumeLive()).toBe('resume on start: resumed 2, skipped 3: deleted (no such node), idle (idle over 3 days), nowt (worktree missing)');
    expect(order).toEqual(['root', 'kid', 'nowt']);
    expect(m.view('root')!.status.exited).toBeFalsy();
    expect(m.view('kid')!.status).toMatchObject({ sessionId: 's-kid' });
    expect(m.view('idle')!.status.exited).toBe(true);
    await expect.poll(saved).toEqual(['root', 'kid']); // only what came back up
    expect(await m.resumeLive()).toBe('resume on start: nothing to resume');
  });
});

describe('NodeManager guardrails', () => {
  let home = '';
  let m: NodeManager;
  afterEach(() => { m.shutdown(); rmSync(home, { recursive: true, force: true }); });

  it('refuses an agent spawn at each cap, naming it; the human is exempt', async () => {
    home = mkdtempSync(join(tmpdir(), 'o8-'));
    const proj = join(home, 'proj');
    mkdirSync(join(proj, '.orchestr8'), { recursive: true });
    writeFileSync(join(proj, '.orchestr8', 'config.json'), JSON.stringify({ limits: { maxDepth: 2, maxChildren: 2, maxLiveNodes: 4 } }));
    m = new NodeManager({ home, shell: '/bin/sh' });
    const spawn = (parentId: string | null, byHuman = false) => m.spawn({ kind: 'terminal', title: 't', cwd: proj, parentId, byHuman }).id;
    const root = spawn(null, true);
    const c1 = spawn(root);
    spawn(root);
    expect(() => spawn(root)).toThrow('refused: limits.maxChildren is 2 and ' + root + ' has 2 live children; reuse an idle worker (send it the work) or close finished ones');
    const c3 = spawn(root, true); // the human is exempt; 4 live now
    expect(() => spawn(c1)).toThrow(/^refused: limits\.maxLiveNodes is 4 and 4 nodes are live; reuse an idle worker/);
    await m.close(c3);
    const g = spawn(c1); // depth 2 is allowed
    expect(() => spawn(g)).toThrow(/^refused: limits\.maxDepth is 2 and the new node would be 3 levels below the root; reuse/);
    expect(m.list()).toHaveLength(4); // nothing was created by the refusals
  });

  it('keeps each node\'s spend across a session restart and a daemon restart', () => {
    home = mkdtempSync(join(tmpdir(), 'o8-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nsleep 5\n'); // stands in for claude
    chmodSync(join(bin, 'claude'), 0o755);
    const opts = { home, shell: '/bin/sh', path: `${bin}:/usr/bin:/bin` };
    m = new NodeManager(opts);
    const id = m.spawn({ kind: 'claude', title: 'c', cwd: home, byHuman: true }).id;
    const measure = (usd: number) => m.applyModEvent(id, { event: 'session.measure', payload: { cost: { usd } } });
    measure(0.5);
    measure(0.8);  // session totals: +0.3
    expect(m.restart(id)).toEqual({ ok: true });
    measure(0.25); // a fresh session counts from zero
    expect(m.view(id)).toMatchObject({ spentUsd: 1.05, status: { costUsd: 0.25 } });
    m.shutdown();
    m = new NodeManager(opts);
    expect(m.view(id)!.spentUsd).toBeCloseTo(1.05);
    expect(m.view(id)!.spentToday).toEqual({ day: new Date().toLocaleDateString('en-CA'), usd: expect.closeTo(1.05) });
    measure(0.1); // the resumed node's first measure after the daemon restart
    expect(m.view(id)!.spentUsd).toBeCloseTo(1.15);
  });
});
