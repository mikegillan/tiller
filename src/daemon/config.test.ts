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
      JSON.stringify({ roles: { worker: { model: 'haiku' } }, worktrees: { include: ['.env'] }, resumeOnStart: false, resumeMaxAgeDays: 1, limits: { maxChildren: 2 } }),
      JSON.stringify({ roles: { worker: { model: 'sonnet', effort: 'high' }, orchestrator: { model: 'opus' } }, closeWithoutConfirm: 'done', worktrees: { isolation: 'worktree', include: ['x'] }, resumeMaxAgeDays: 7, limits: { maxChildren: 5, stallMinutes: 2 } }),
    );
    const proj = join(cwd, '.orchestr8', 'config.json'), home = join(homeDir, 'config.json');
    expect(loadConfig(cwd, homeDir)).toEqual({
      roles: { orchestrator: { model: 'opus' }, worker: { model: 'haiku', effort: 'high' } }, closeWithoutConfirm: 'done',
      worktrees: { isolation: 'worktree', branchPrefix: 'o8/', include: ['.env'] }, // include replaces the home list whole
      resumeOnStart: true, resumeMaxAgeDays: 7, // daemon settings ignore the project file
      limits: { maxDepth: 3, maxChildren: 2, maxLiveNodes: 20, stallMinutes: 2, maxMessagesPer10Min: 20 },
      sources: {
        'roles.orchestrator.model': home, 'roles.orchestrator.effort': 'default',
        'roles.worker.model': proj, 'roles.worker.effort': home, closeWithoutConfirm: home,
        'worktrees.isolation': home, 'worktrees.branchPrefix': 'default', 'worktrees.include': proj,
        resumeOnStart: 'default', resumeMaxAgeDays: home,
        'limits.maxDepth': 'default', 'limits.maxChildren': proj, 'limits.maxLiveNodes': 'default', 'limits.stallMinutes': home, 'limits.maxMessagesPer10Min': 'default',
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
    for (const bad of ['{not json', JSON.stringify({ closeWithoutConfirm: 'sometimes' }), JSON.stringify({ roles: { worker: { effort: 'extreme' } } }), JSON.stringify({ worktrees: { isolaton: 'worktree' } })]) {
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
