import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { NodeManager } from './manager.js';
import { findDaemon, humanEnv, pickOrchestrator, upDir, type OrchestratorCandidate } from './up.js';

const node = (o: Partial<OrchestratorCandidate>): OrchestratorCandidate => ({ id: 'x', title: 't', kind: 'claude', parentId: null, cwd: '/repo', createdAt: 1, ...o });

describe('pickOrchestrator', () => {
  it('ignores exited nodes, children, other dirs and terminals', () => {
    const nodes = [node({ id: 'dead', exited: true }), node({ id: 'kid', parentId: 'p' }), node({ id: 'else', cwd: '/other' }), node({ id: 'sh', kind: 'terminal' })];
    expect(pickOrchestrator(nodes, '/repo')).toBeUndefined();
  });
  it('prefers the most recently created match', () => {
    const nodes = [node({ id: 'old', createdAt: 1 }), node({ id: 'new', createdAt: 5 }), node({ id: 'mid', createdAt: 3 })];
    expect(pickOrchestrator(nodes, '/repo')?.id).toBe('new');
  });
});

describe('pickOrchestrator harness', () => {
  it('defaults to claude and ignores pi nodes', () => {
    const nodes = [node({ id: 'pi', kind: 'agent', harness: 'pi' }), node({ id: 'claude' })];
    expect(pickOrchestrator(nodes, '/repo')?.id).toBe('claude');
    expect(pickOrchestrator(nodes, '/repo', false, 'pi')?.id).toBe('pi');
  });
  it('treats a legacy claude root with no harness as claude and never as pi', () => {
    const nodes = [node({ id: 'legacy' })];
    expect(pickOrchestrator(nodes, '/repo')?.id).toBe('legacy');
    expect(pickOrchestrator(nodes, '/repo', false, 'pi')).toBeUndefined();
  });
  it('filters exited roots by harness too', () => {
    const nodes = [node({ id: 'livePi', kind: 'agent', harness: 'pi' }), node({ id: 'deadPi', kind: 'agent', harness: 'pi', exited: true })];
    expect(pickOrchestrator(nodes, '/repo', true, 'pi')?.id).toBe('deadPi');
    expect(pickOrchestrator(nodes, '/repo', true, 'claude')).toBeUndefined();
  });
});

describe('pickOrchestrator, exited', () => {
  it('returns the newest exited root only when asked', () => {
    const nodes = [node({ id: 'live' }), node({ id: 'd1', exited: true, createdAt: 2 }), node({ id: 'd2', exited: true, createdAt: 9 }), node({ id: 'kid', exited: true, parentId: 'p', createdAt: 99 })];
    expect(pickOrchestrator(nodes, '/repo', true)?.id).toBe('d2');
    expect(pickOrchestrator(nodes, '/repo')?.id).toBe('live');
  });
});

describe('upDir', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tl-updir-')));
  mkdirSync(join(tmp, 'repo'));
  writeFileSync(join(tmp, 'file'), '');
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  it('opens no directory without a path or a directory flag', () => expect(upDir(undefined, false, tmp)).toBeUndefined());
  it('resolves a path against cwd, and a directory flag alone to cwd', () => {
    expect(upDir('.', false, tmp)).toBe(tmp);
    expect(upDir('repo', false, tmp)).toBe(join(tmp, 'repo'));
    expect(upDir(undefined, true, join(tmp, 'repo'))).toBe(join(tmp, 'repo'));
  });
  it('expands ~ to the home directory', () => expect(upDir('~/repo', false, '/', tmp)).toBe(join(tmp, 'repo')));
  it('fails on a missing path or a file', () => {
    expect(() => upDir('nope', false, tmp)).toThrow(`no such directory: ${join(tmp, 'nope')}`);
    expect(() => upDir('file', false, tmp)).toThrow(`not a directory: ${join(tmp, 'file')}`);
  });
});

describe('humanEnv', () => {
  it('drops the node identity and keeps home, port and the rest', () => {
    const env = { TL_NODE_ID: 'n-1', TL_TOKEN_FILE: '/t', TL_ENDPOINT: 'http://x', TL_HOME: '/h', TL_PORT: '9', PATH: '/bin' };
    expect(humanEnv(env)).toEqual({ TL_HOME: '/h', TL_PORT: '9', PATH: '/bin' });
  });
});

describe('findDaemon', () => {
  let srv: http.Server | undefined;
  afterEach(() => new Promise<void>((ok) => (srv ? srv.close(() => ok()) : ok())));
  const serve = async (handler: http.RequestListener) => {
    srv = http.createServer(handler);
    await new Promise<void>((ok) => srv!.listen(0, '127.0.0.1', ok));
    return (srv.address() as { port: number }).port;
  };

  it('returns the health body when /health answers', async () => {
    const port = await serve((_, res) => res.end(JSON.stringify({ ok: true, pid: 42, home: '/h', version: '1' })));
    expect(await findDaemon(port)).toMatchObject({ pid: 42, home: '/h' });
  });
  it('gives up on a hung server within the timeout', async () => {
    const port = await serve(() => {});
    const t = Date.now();
    expect(await findDaemon(port, 100)).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(1000);
  });
  it('returns undefined when nothing listens', async () => {
    const port = await serve((_, res) => res.end('{}'));
    await new Promise<void>((ok) => srv!.close(() => ok()));
    srv = undefined;
    expect(await findDaemon(port)).toBeUndefined();
  });
});

describe('spawn-or-reuse with a real manager', () => {
  let home = '';
  let m: NodeManager;
  afterEach(async () => { await m.shutdown(); rmSync(home, { recursive: true, force: true }); });

  it('reuses the orchestrator for the realpath of cwd, spawns none for a new dir', async () => {
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    m = new NodeManager({ home, shell: '/bin/sh' });
    const dir = realpathSync(tmpdir()); // /var -> /private/var on macOS
    const v = (await m.spawn({ kind: 'terminal', title: 'orch', cwd: dir, parentId: null }));
    const asClaude = [{ ...v, kind: 'claude' as const, exited: false }]; // terminal stands in for claude: no real claude in tests
    expect(pickOrchestrator(asClaude, dir)?.id).toBe(v.id);
    expect(pickOrchestrator(asClaude, join(dir, 'other'))).toBeUndefined();
  });
});
