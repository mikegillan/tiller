import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configEntries, loadConfig } from './config.js';

describe('loadConfig', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const setup = (project: string | undefined, home: string | undefined) => {
    dir = mkdtempSync(join(tmpdir(), 'tl-cfg-'));
    const cwd = join(dir, 'repo'), homeDir = join(dir, 'home');
    mkdirSync(join(cwd, '.tiller'), { recursive: true });
    mkdirSync(homeDir);
    if (project !== undefined) writeFileSync(join(cwd, '.tiller', 'config.json'), project);
    if (home !== undefined) writeFileSync(join(homeDir, 'config.json'), home);
    return { cwd, homeDir };
  };

  it('resolves each key from the project file, then the home file, then the default', () => {
    const { cwd, homeDir } = setup(
      JSON.stringify({ roles: { worker: { model: 'haiku' } }, worktrees: { include: ['.env'], mergeStyle: 'squash' }, gate: { command: 'npm test' }, limits: { maxChildren: 2 }, notifications: { kinds: { done: 'silent' } } }),
      JSON.stringify({ roles: { worker: { model: 'sonnet', effort: 'high' }, orchestrator: { model: 'opus' } }, approvals: { close: 'done' }, worktrees: { isolation: 'worktree', include: ['x'], setup: ['npm ci'] }, gate: { command: 'make', retries: 5 }, daemon: { resumeMaxAgeDays: 7, digestAfterMinutes: 30, maxWorking: 4 }, limits: { maxChildren: 5, stallMinutes: 2 }, notifications: { kinds: { done: 'sound', exited: 'silent' }, quietHours: '22:00-07:00' } }),
    );
    const proj = join(cwd, '.tiller', 'config.json'), home = join(homeDir, 'config.json');
    expect(loadConfig(cwd, homeDir)).toEqual({
      roles: { orchestrator: { model: 'opus' }, worker: { model: 'haiku', effort: 'high' } }, approvals: { close: 'done', merge: false },
      worktrees: { isolation: 'worktree', branchPrefix: 'tl/', include: ['.env'], mergeStyle: 'squash', setup: ['npm ci'], teardown: [] }, // include replaces the home list whole
      gate: { command: 'npm test', retries: 5, timeoutMinutes: 10 }, // each gate key resolves on its own
      daemon: { resumeOnStart: true, resumeMaxAgeDays: 7, sessionsKeepDays: 14, digestAfterMinutes: 30, maxLiveNodes: 20, maxWorking: 4 },
      limits: { maxDepth: 3, maxChildren: 2, stallMinutes: 2, maxMessagesPer10Min: 20 },
      notifications: { kinds: { needsYou: 'sound', errored: 'sound', done: 'silent', exited: 'silent' }, treeDoneSummary: false, quietHours: '22:00-07:00' },
    });
    const sources = Object.fromEntries(Object.entries(configEntries(cwd, homeDir)).map(([k, e]) => [k, e.source]));
    expect(sources).toEqual({
      'roles.orchestrator.model': home, 'roles.orchestrator.effort': 'default', 'roles.worker.model': proj, 'roles.worker.effort': home,
      'approvals.close': home, 'approvals.merge': 'default',
      'worktrees.isolation': home, 'worktrees.branchPrefix': 'default', 'worktrees.include': proj, 'worktrees.mergeStyle': proj, 'worktrees.setup': home, 'worktrees.teardown': 'default',
      'gate.command': proj, 'gate.retries': home, 'gate.timeoutMinutes': 'default',
      'daemon.resumeOnStart': 'default', 'daemon.resumeMaxAgeDays': home, 'daemon.sessionsKeepDays': 'default', 'daemon.digestAfterMinutes': home, 'daemon.maxLiveNodes': 'default', 'daemon.maxWorking': home,
      'notifications.kinds.needsYou': 'default', 'notifications.kinds.done': proj, 'notifications.kinds.errored': 'default', 'notifications.kinds.exited': home,
      'notifications.treeDoneSummary': 'default', 'notifications.quietHours': home,
      'limits.maxDepth': 'default', 'limits.maxChildren': proj, 'limits.stallMinutes': home, 'limits.maxMessagesPer10Min': 'default',
    });
    expect(configEntries(cwd, homeDir)['gate.timeoutMinutes']).toEqual({ value: 10, source: 'default' });
  });

  it('defaults to no model, never and no gate when there are no files', () => {
    const { cwd, homeDir } = setup(undefined, undefined);
    const c = loadConfig(cwd, homeDir);
    expect(c).toMatchObject({ roles: { orchestrator: {}, worker: {} }, approvals: { close: 'never', merge: false }, worktrees: { isolation: 'none', branchPrefix: 'tl/' }, daemon: { resumeOnStart: true, resumeMaxAgeDays: 3 } });
    expect(c.worktrees.include).toBeUndefined();
    expect(c.gate).toBeUndefined();
  });

  it('drops only the bad key of a file, naming it in one log line, and falls back to home for it', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cases: [string, string][] = [
      [JSON.stringify({ closeWithoutConfirm: 'done', limits: { maxChildren: 2 } }), 'closeWithoutConfirm: unknown key'], // an old name
      [JSON.stringify({ approvals: { close: 'sometimes' }, limits: { maxChildren: 2 } }), 'approvals.close'],
      [JSON.stringify({ roles: { worker: { effort: 'extreme' } }, limits: { maxChildren: 2 } }), 'roles.worker.effort'],
      [JSON.stringify({ worktrees: { isolaton: 'worktree' }, limits: { maxChildren: 2 } }), 'worktrees.isolaton: unknown key'],
      [JSON.stringify({ notifications: { quietHours: '22-7' }, limits: { maxChildren: 2 } }), 'notifications.quietHours'],
      [JSON.stringify({ daemon: { maxWorking: 1 }, limits: { maxChildren: 2 } }), 'daemon: read from the home file only'],
    ];
    for (const [bad, named] of cases) {
      const { cwd, homeDir } = setup(bad, JSON.stringify({ roles: { worker: { effort: 'low' } }, approvals: { close: 'always' }, daemon: { maxWorking: 3 } }));
      err.mockClear();
      expect(loadConfig(cwd, homeDir)).toMatchObject({ roles: { worker: { effort: 'low' } }, approvals: { close: 'always' }, daemon: { maxWorking: 3 }, limits: { maxChildren: 2 } });
      loadConfig(cwd, homeDir);
      expect(err).toHaveBeenCalledTimes(1);
      expect(err.mock.calls[0]![0]).toContain(named);
      rmSync(dir, { recursive: true, force: true });
    }
    err.mockRestore();
  });

  it('skips a file that is not JSON with one log line', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { cwd, homeDir } = setup('{not json', JSON.stringify({ approvals: { close: 'always' } }));
    expect(loadConfig(cwd, homeDir).approvals.close).toBe('always');
    loadConfig(cwd, homeDir);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
