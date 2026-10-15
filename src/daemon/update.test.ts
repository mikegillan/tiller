import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyUpdate, checkUpdate, planSteps } from './update.js';

const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...ident } }).trim();
/** Write `file` in `repo` and commit it with `subject`. */
const commit = (repo: string, file: string, subject: string) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), `${subject}\n`);
  git(repo, 'add', file);
  git(repo, 'commit', '-qm', subject);
};

let dir: string, seed: string, work: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tl-update-'));
  git(dir, 'init', '-q', '--bare', 'origin.git');
  seed = join(dir, 'seed');
  git(dir, 'clone', '-q', 'origin.git', 'seed');
  commit(seed, 'README', 'first');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  git(dir, 'clone', '-q', 'origin.git', 'work'); // origin/HEAD names main
  work = join(dir, 'work');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('checkUpdate', () => {
  it('is eligible and counts the commits behind, naming the newest', async () => {
    commit(seed, 'a', 'second');
    commit(seed, 'b', 'third');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    const s = await checkUpdate(work, true);
    expect(s).toMatchObject({ eligible: true, branch: 'main', behind: 2, newest: 'third', sha: git(work, 'rev-parse', 'HEAD') });
    expect(s.reason).toBeUndefined();
    expect(s.fetchError).toBeUndefined();
  });

  it('is up to date with nothing new', async () => {
    expect(await checkUpdate(work, true)).toMatchObject({ eligible: true, behind: 0 });
  });

  it('gives a reason when tracked files are dirty, there are local commits, or HEAD is on another branch', async () => {
    writeFileSync(join(work, 'README'), 'edited\n');
    expect((await checkUpdate(work, false)).reason).toBe('uncommitted changes');
    git(work, 'checkout', '-q', '--', 'README');
    writeFileSync(join(work, 'untracked'), 'x');
    expect((await checkUpdate(work, false)).eligible).toBe(true); // untracked files do not count
    commit(work, 'local', 'mine');
    expect((await checkUpdate(work, false)).reason).toBe('local commits not on origin/main');
    git(work, 'checkout', '-qb', 'tl/x');
    expect((await checkUpdate(work, false)).reason).toBe('on branch tl/x');
  });

  it('says so without an origin remote', async () => {
    git(work, 'remote', 'remove', 'origin');
    expect(await checkUpdate(work, true)).toMatchObject({ eligible: false, reason: 'no origin remote' });
  });

  it('records a failed fetch instead of throwing', async () => {
    git(work, 'remote', 'set-url', 'origin', join(dir, 'gone.git'));
    const s = await checkUpdate(work, true);
    expect(s.fetchError).toBeTruthy();
    expect(s.eligible).toBe(true);
  });
});

describe('planSteps', () => {
  it('installs packages for a lockfile change and rebuilds the UI after it', () => {
    expect(planSteps(['package-lock.json'], false)).toEqual({ install: true, ui: true, app: false });
  });
  it('rebuilds the UI for ui/ and src/shared/, and nothing for daemon code', () => {
    expect(planSteps(['ui/StatusBar.tsx'], true)).toEqual({ install: false, ui: true, app: false });
    expect(planSteps(['src/shared/protocol.ts'], false)).toEqual({ install: false, ui: true, app: false });
    expect(planSteps(['src/daemon/cli.ts', 'README.md'], true)).toEqual({ install: false, ui: false, app: false });
  });
  it('builds the app for src-tauri/ only when Tiller.app exists', () => {
    expect(planSteps(['src-tauri/src/main.rs'], true).app).toBe(true);
    expect(planSteps(['src-tauri/src/main.rs'], false).app).toBe(false);
  });
});

describe('applyUpdate', () => {
  /** A PATH whose npm exits with `code`. */
  const stubNpm = (code: number) => {
    const bin = join(dir, `bin${code}`);
    mkdirSync(bin);
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "stub npm $*"\nexit ${code}\n`);
    chmodSync(join(bin, 'npm'), 0o755);
    return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  };

  beforeEach(() => {
    commit(seed, 'ui/App.tsx', 'new ui');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    git(work, 'fetch', '-q', 'origin');
  });

  it('moves the checkout back and does not restart when a build step fails', async () => {
    const old = git(work, 'rev-parse', 'HEAD');
    const log = join(dir, 'update.log');
    let restarted = false;
    await expect(applyUpdate({ repo: work, log, env: stubNpm(1), restart: async () => { restarted = true; }, notify: () => {} }))
      .rejects.toThrow('npm run ui:build failed');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(old);
    expect(restarted).toBe(false);
    const text = readFileSync(log, 'utf8');
    expect(text).toContain('stub npm run ui:build');
    expect(text).toContain('npm run ui:build failed (exit 1); moving the checkout back');
  });

  it('rebuilds the UI at the old sha after rolling back a failed build', async () => {
    const old = git(work, 'rev-parse', 'HEAD');
    const log = join(dir, 'update.log');
    // npm fails on its first run and succeeds after, recording the sha each run saw.
    const bin = join(dir, 'binflaky');
    mkdirSync(bin);
    const [builds, failed] = [join(dir, 'builds'), join(dir, 'failed')];
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$* at $(git rev-parse HEAD)" >> ${builds}\nif [ ! -e ${failed} ]; then touch ${failed}; exit 1; fi\n`);
    chmodSync(join(bin, 'npm'), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    await expect(applyUpdate({ repo: work, log, env, restart: async () => {}, notify: () => {} })).rejects.toThrow('npm run ui:build failed');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(old);
    expect(readFileSync(builds, 'utf8').trim().split('\n')).toEqual([`run ui:build at ${git(work, 'rev-parse', 'origin/main')}`, `run ui:build at ${old}`]);
    expect(readFileSync(log, 'utf8')).toContain(`rollback: rerunning npm run ui:build at ${old.slice(0, 7)}`);
  });

  it('fast-forwards, builds the UI without npm install, then restarts', async () => {
    const log = join(dir, 'update.log');
    let restarted = false;
    await applyUpdate({ repo: work, log, env: stubNpm(0), restart: async () => { restarted = true; }, notify: () => {} });
    expect(git(work, 'rev-parse', 'HEAD')).toBe(git(work, 'rev-parse', 'origin/main'));
    expect(restarted).toBe(true);
    const text = readFileSync(log, 'utf8');
    expect(text).toContain('running npm run ui:build');
    expect(text).not.toContain('npm install');
  });
});
