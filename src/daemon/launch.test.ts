import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Role } from '../shared/protocol.js';
import { DEFAULT_PROMPTS, ensurePrompts, launchArgs, promptPath, systemPrompt, terminalBundleFor } from './launch.js';

describe('terminalBundleFor', () => {
  it('maps known TERM_PROGRAM values', () => {
    expect(terminalBundleFor('ghostty')).toBe('com.mitchellh.ghostty');
    expect(terminalBundleFor('iTerm.app')).toBe('com.googlecode.iterm2');
    expect(terminalBundleFor('WezTerm')).toBe('com.github.wez.wezterm');
  });
  it('returns undefined for unknown or missing values', () => {
    expect(terminalBundleFor('xterm')).toBeUndefined();
    expect(terminalBundleFor(undefined)).toBeUndefined();
  });
});

describe('launchArgs', () => {
  const base = { nodeId: 'n', nodeDir: '/tmp/n', endpoint: 'http://x', path: '', title: 't', parentId: null, home: '/nonexistent', cwd: '/nonexistent', sessionId: 's' };
  it('passes the permission mode only when set', () => {
    const i = launchArgs({ ...base, permissionMode: 'auto' }).indexOf('--permission-mode');
    expect(launchArgs({ ...base, permissionMode: 'auto' }).slice(i, i + 2)).toEqual(['--permission-mode', 'auto']);
    expect(launchArgs(base)).not.toContain('--permission-mode');
  });
});

describe('role prompts', () => {
  const dirs: string[] = [];
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'o8-roles-')); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const prompt = (home: string, cwd: string, parentId: string | null, role?: Role) => systemPrompt({ nodeId: 'n', title: 't', parentId, home, cwd, role });

  it('picks orchestrator for a root, worker for a child, and honours an explicit role', () => {
    const home = tmp(); ensurePrompts(home);
    expect(prompt(home, home, null)).toContain('You are the orchestrator');
    expect(prompt(home, home, 'p')).toContain('You are a worker');
    expect(prompt(home, home, 'p', 'orchestrator')).toContain('You are the orchestrator');
    expect(prompt(home, home, null, 'none')).not.toContain('# Role');
  });
  it('writes defaults once and never overwrites an edit', () => {
    const home = tmp(); ensurePrompts(home);
    const f = join(home, 'prompts', 'worker.md');
    expect(readFileSync(f, 'utf8')).toBe(DEFAULT_PROMPTS.worker);
    writeFileSync(f, 'custom');
    ensurePrompts(home);
    expect(readFileSync(f, 'utf8')).toBe('custom');
    expect(prompt(home, home, 'p')).toContain('# Role\ncustom'); // read fresh, not cached
  });
  it('lets a repo override beat the home file', () => {
    const home = tmp(), repo = tmp(); ensurePrompts(home);
    mkdirSync(join(repo, '.orchestr8'));
    writeFileSync(join(repo, '.orchestr8', 'worker.md'), 'repo worker');
    expect(prompt(home, repo, 'p')).toContain('repo worker');
    expect(promptPath(home, repo, 'worker').override).toBe(true);
    expect(prompt(home, repo, null)).toContain('You are the orchestrator'); // no override for that role
  });
  it('puts the role text in --append-system-prompt and stays compact', () => {
    const home = tmp(); ensurePrompts(home);
    const args = launchArgs({ nodeId: 'n', nodeDir: '/tmp/n', endpoint: 'http://x', path: '', title: 't', parentId: null, home, cwd: home, sessionId: 's' });
    const sp = args[args.indexOf('--append-system-prompt') + 1]!;
    expect(sp).toContain('You are the orchestrator for this repository');
    expect(sp.split(/\s+/).length).toBeLessThan(700);
  });
});
