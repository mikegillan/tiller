import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const setup = (project: string | undefined, home: string | undefined) => {
    dir = mkdtempSync(join(tmpdir(), 'o8-cfg-'));
    const cwd = join(dir, 'repo'), homeDir = join(dir, 'home');
    mkdirSync(join(cwd, '.orchestr8'), { recursive: true });
    mkdirSync(homeDir);
    if (project !== undefined) writeFileSync(join(cwd, '.orchestr8', 'config.json'), project);
    if (home !== undefined) writeFileSync(join(homeDir, 'config.json'), home);
    return { cwd, homeDir };
  };

  it('resolves each key from the project file, then the home file, then the default', () => {
    const { cwd, homeDir } = setup(
      JSON.stringify({ roles: { worker: { model: 'haiku' } }, worktrees: { include: ['.env'], merge: 'squash' }, gate: { command: 'npm test' }, resumeOnStart: false, resumeMaxAgeDays: 1, sessionsKeepDays: 1, limits: { maxChildren: 2 }, notifications: { kinds: { done: 'silent' } } }),
      JSON.stringify({ roles: { worker: { model: 'sonnet', effort: 'high' }, orchestrator: { model: 'opus' } }, closeWithoutConfirm: 'done', worktrees: { isolation: 'worktree', include: ['x'], setup: ['npm ci'] }, gate: { command: 'make', retries: 5 }, resumeMaxAgeDays: 7, digestAfterMinutes: 30, limits: { maxChildren: 5, stallMinutes: 2 }, notifications: { kinds: { done: 'sound', exited: 'silent' }, quietHours: '22:00-07:00' } }),
    );
    const proj = join(cwd, '.orchestr8', 'config.json'), home = join(homeDir, 'config.json');
    expect(loadConfig(cwd, homeDir)).toEqual({
      roles: { orchestrator: { model: 'opus' }, worker: { model: 'haiku', effort: 'high' } }, closeWithoutConfirm: 'done',
      worktrees: { isolation: 'worktree', branchPrefix: 'o8/', include: ['.env'], merge: 'squash', mergeWithoutConfirm: false, setup: ['npm ci'], teardown: [] }, // include replaces the home list whole
      gate: { command: 'npm test', retries: 5, timeoutMinutes: 10 }, // each gate key resolves on its own
      resumeOnStart: true, resumeMaxAgeDays: 7, sessionsKeepDays: 14, digestAfterMinutes: 30, // daemon settings ignore the project file
      limits: { maxDepth: 3, maxChildren: 2, maxLiveNodes: 20, stallMinutes: 2, maxMessagesPer10Min: 20, maxWorking: 0 },
      notifications: { kinds: { needsYou: 'sound', errored: 'sound', done: 'silent', exited: 'silent' }, failuresOnly: false, treeDoneSummary: false, quietHours: '22:00-07:00' },
      sources: {
        'roles.orchestrator.model': home, 'roles.orchestrator.effort': 'default',
        'roles.worker.model': proj, 'roles.worker.effort': home, closeWithoutConfirm: home,
        'worktrees.isolation': home, 'worktrees.branchPrefix': 'default', 'worktrees.include': proj,
        'worktrees.merge': proj, 'worktrees.mergeWithoutConfirm': 'default', 'worktrees.setup': home, 'worktrees.teardown': 'default',
        'gate.command': proj, 'gate.retries': home, 'gate.timeoutMinutes': 'default',
        resumeOnStart: 'default', resumeMaxAgeDays: home, sessionsKeepDays: 'default', digestAfterMinutes: home,
        'limits.maxDepth': 'default', 'limits.maxChildren': proj, 'limits.maxLiveNodes': 'default', 'limits.stallMinutes': home, 'limits.maxMessagesPer10Min': 'default', 'limits.maxWorking': 'default',
        'notifications.kinds.needsYou': 'default', 'notifications.kinds.done': proj, 'notifications.kinds.errored': 'default', 'notifications.kinds.exited': home,
        'notifications.failuresOnly': 'default', 'notifications.treeDoneSummary': 'default', 'notifications.quietHours': home,
      },
    });
  });

  it('defaults to no model and never when there are no files', () => {
    const { cwd, homeDir } = setup(undefined, undefined);
    expect(loadConfig(cwd, homeDir)).toMatchObject({ roles: { orchestrator: {}, worker: {} }, closeWithoutConfirm: 'never', worktrees: { isolation: 'none', branchPrefix: 'o8/' }, resumeOnStart: true, resumeMaxAgeDays: 3, sources: { 'roles.worker.model': 'default' } });
    expect(loadConfig(cwd, homeDir).worktrees.include).toBeUndefined();
  });

  it('skips a malformed project file with one log line and falls back to home', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const bad of ['{not json', JSON.stringify({ closeWithoutConfirm: 'sometimes' }), JSON.stringify({ roles: { worker: { effort: 'extreme' } } }), JSON.stringify({ worktrees: { isolaton: 'worktree' } }), JSON.stringify({ notifications: { quietHours: '22-7' } })]) {
      const { cwd, homeDir } = setup(bad, JSON.stringify({ roles: { worker: { model: 'sonnet' } }, closeWithoutConfirm: 'always' }));
      err.mockClear();
      expect(loadConfig(cwd, homeDir)).toMatchObject({ roles: { worker: { model: 'sonnet' } }, closeWithoutConfirm: 'always' });
      loadConfig(cwd, homeDir);
      expect(err).toHaveBeenCalledTimes(1);
      rmSync(dir, { recursive: true, force: true });
    }
    err.mockRestore();
  });
});
