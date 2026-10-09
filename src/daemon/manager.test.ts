import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    expect(statSync(join(dir, 'settings.json')).isFile()).toBe(true);
    m.close(n.id);
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
