import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyUpdate, checkUpdate, createUpdater, planSteps } from './update.js';

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
  let log: string, lock: string;
  /** A PATH whose npm runs `script` (sh) with its arguments, after logging them. */
  const stubNpm = (script: string) => {
    const bin = mkdtempSync(join(dir, 'bin'));
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "stub npm $*"\n${script}\n`);
    chmodSync(join(bin, 'npm'), 0o755);
    return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  };
  const apply = (env: NodeJS.ProcessEnv, restart = async () => {}) => applyUpdate({ repo: work, log, lock, env, restart, notify: () => {} });

  beforeEach(() => {
    [log, lock] = [join(dir, 'update.log'), join(dir, 'update.lock')];
    commit(seed, 'ui/App.tsx', 'new ui');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    git(work, 'fetch', '-q', 'origin');
  });

  it('moves the checkout back and does not restart when a build step fails', async () => {
    const old = git(work, 'rev-parse', 'HEAD');
    let restarted = false;
    await expect(apply(stubNpm('exit 1'), async () => { restarted = true; })).rejects.toThrow(`npm run ui:build failed (exit 1); the checkout is back at ${old.slice(0, 7)}`);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(old);
    expect(restarted).toBe(false);
    expect(existsSync(lock)).toBe(false);
    const text = readFileSync(log, 'utf8');
    expect(text).toContain('stub npm run ui:build');
    expect(text).toContain('npm run ui:build failed (exit 1); moving the checkout back');
  });

  it('rebuilds the UI at the old sha after rolling back a failed build', async () => {
    const old = git(work, 'rev-parse', 'HEAD');
    // npm fails on its first run and succeeds after, recording the sha each run saw.
    const [builds, failed] = [join(dir, 'builds'), join(dir, 'failed')];
    const env = stubNpm(`echo "$* at $(git rev-parse HEAD)" >> ${builds}\nif [ ! -e ${failed} ]; then touch ${failed}; exit 1; fi`);
    await expect(apply(env)).rejects.toThrow('npm run ui:build failed');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(old);
    expect(readFileSync(builds, 'utf8').trim().split('\n')).toEqual([`run ui:build at ${git(work, 'rev-parse', 'origin/main')}`, `run ui:build at ${old}`]);
    expect(readFileSync(log, 'utf8')).toContain(`rollback: rerunning npm run ui:build at ${old.slice(0, 7)}`);
  });

  it('uses npm ci, and restores a rewritten package-lock.json so the rollback can reset', async () => {
    commit(seed, 'package-lock.json', 'new lock');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    git(work, 'fetch', '-q', 'origin');
    const old = git(work, 'rev-parse', 'HEAD');
    // ci rewrites the lock anyway; the build fails.
    const env = stubNpm('if [ "$1" = ci ]; then echo rewritten > package-lock.json; else exit 1; fi');
    await expect(apply(env)).rejects.toThrow('npm run ui:build failed');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(old);
    expect(git(work, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(readFileSync(log, 'utf8')).toContain('running npm ci');
  });

  it('says when the rollback itself fails, naming both shas', async () => {
    const old = git(work, 'rev-parse', 'HEAD');
    const now = git(work, 'rev-parse', 'origin/main');
    // A local edit to a file the update changed makes git reset --keep refuse.
    const env = stubNpm('echo local > ui/App.tsx; exit 1');
    await expect(apply(env)).rejects.toThrow(`and the rollback failed: the checkout is left at ${now.slice(0, 7)} while the daemon runs ${old.slice(0, 7)}; see ${log}`);
    expect(existsSync(lock)).toBe(false);
  });

  it('refuses while a live helper holds the lock', async () => {
    const old = git(work, 'rev-parse', 'HEAD');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, sha: old }));
    await expect(apply(stubNpm('exit 0'))).rejects.toThrow(`another update holds ${lock} (pid ${process.pid})`);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(old);
  });

  it('fast-forwards, builds the UI without npm ci, then restarts and releases the lock', async () => {
    let restarted = false;
    await apply(stubNpm('exit 0'), async () => { restarted = existsSync(lock); });
    expect(git(work, 'rev-parse', 'HEAD')).toBe(git(work, 'rev-parse', 'origin/main'));
    expect(restarted).toBe(true); // the lock is held through the restart
    expect(existsSync(lock)).toBe(false);
    const text = readFileSync(log, 'utf8');
    expect(text).toContain('running npm run ui:build');
    expect(text).not.toContain('npm ci');
  });
});

describe('createUpdater', () => {
  let exits: Array<(code: number | null, signal: NodeJS.Signals | null) => void>;
  const updater = () => createUpdater({ repo: work, home: dir, onChange: () => {}, spawnHelper: (onExit) => { exits.push(onExit); return join(dir, 'update.log'); } });
  beforeEach(() => {
    exits = [];
    commit(seed, 'a', 'second');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
  });

  it('starts one helper when two applies race, and clears applying when it exits without restarting', async () => {
    const u = updater();
    const [a, b] = await Promise.allSettled([u.apply(), u.apply()]);
    expect(a.status).toBe('fulfilled');
    expect(b).toMatchObject({ status: 'rejected', reason: new Error('an update is already running') });
    expect(exits).toHaveLength(1);
    expect(u.status().applying).toBe(true);
    exits[0](0, null); // already up to date
    expect(u.status().applying).toBeUndefined();
    expect(u.status().failed).toBeUndefined();
  });

  it('reports a helper killed by a signal', async () => {
    const u = updater();
    await u.apply();
    exits[0](null, 'SIGKILL');
    expect(u.status().applying).toBeUndefined();
    expect(u.status().failed).toBe(`update failed: the helper was killed (SIGKILL); see ${join(dir, 'update.log')}`);
  });

  it('removes a lock left by a dead helper and says the update was interrupted', async () => {
    const lock = join(dir, 'update.lock');
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 1, sha: 'abcdef1234' }));
    const s = await updater().check(false);
    expect(s.failed).toBe(`a previous update from abcdef1 was interrupted; see ${join(dir, 'update.log')}`);
    expect(existsSync(lock)).toBe(false);
  });
});
