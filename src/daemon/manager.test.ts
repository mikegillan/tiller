import { mkdtempSync, rmSync, statSync } from 'node:fs';
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

  it('writes node files with restrictive modes and removes them on close', () => {
    home = mkdtempSync(join(tmpdir(), 'o8-'));
    m = new NodeManager({ home, shell: '/bin/sh' });
    const n = m.spawn({ kind: 'terminal', title: 't', cwd: tmpdir() });
    const dir = join(home, 'nodes', n.id);
    expect(statSync(join(dir, 'token')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'mcp.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'hook-headers')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'settings.json')).isFile()).toBe(true);
    expect(() => m.close(n.id)).toThrow(/orchestrator/);
    m.close(n.id, true);
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

  it('relaunches a terminal node with a new process, same id, children kept; refuses to close a root; prune keeps a live root', () => {
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
    expect(() => m.close(root.id)).toThrow(/orchestrator/);
    m.close(kid.id); // a child closes without force
    expect(m.prune()).toEqual([]);
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
