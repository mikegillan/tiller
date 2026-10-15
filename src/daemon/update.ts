// Updating tiller from its own checkout: whether origin's default branch has commits this checkout can fast-forward
// to, and the detached `tl update --detached` helper that applies them, rebuilds what changed and restarts the daemon.
import { execFile, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { UpdateStatus } from '../shared/protocol.js';

/** The checkout this daemon's source lives in. */
export const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const APP_BUNDLE = 'src-tauri/target/release/bundle/macos/Tiller.app';
/** In <home>: the helper's log, and its lock, which holds { pid, sha } while it changes the checkout. */
export const UPDATE_LOG = 'update.log';
export const UPDATE_LOCK = 'update.lock';
const GIT_TIMEOUT_MS = 60_000;
// Generous, so a hung step fails into the rollback instead of hanging forever.
const CI_TIMEOUT_MS = 10 * 60_000;
const UI_TIMEOUT_MS = 5 * 60_000;
const APP_TIMEOUT_MS = 30 * 60_000;
const exec = promisify(execFile);

const git = async (repo: string, ...args: string[]): Promise<string> =>
  (await exec('git', args, { cwd: repo, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
const tryGit = (repo: string, ...args: string[]) => git(repo, ...args).catch(() => undefined);
const firstLine = (e: { stderr?: string; message: string }) => (e.stderr?.trim() || e.message).split('\n')[0];
const short = (sha: string) => sha.slice(0, 7);

/** Fetch `branch` without ever waiting for a password or host-key prompt: the ssh command in effect (GIT_SSH_COMMAND, else core.sshCommand, else ssh) runs in batch mode. */
async function fetchBranch(repo: string, branch: string): Promise<void> {
  const ssh = process.env.GIT_SSH_COMMAND || (await tryGit(repo, 'config', 'core.sshCommand')) || 'ssh';
  await exec('git', ['fetch', '--quiet', 'origin', branch], {
    cwd: repo, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: `${ssh} -o BatchMode=yes` },
  });
}

export interface UpdateLock { pid: number; sha: string }
export const readLock = (path: string): UpdateLock | undefined => { try { return JSON.parse(readFileSync(path, 'utf8')) as UpdateLock; } catch { return undefined; } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
/** The lock at `path` when a live helper holds it. */
export const lockHolder = (path: string): UpdateLock | undefined => { const l = readLock(path); return l && alive(l.pid) ? l : undefined; };

/**
 * Where `repo` stands against origin's default branch (origin/HEAD, else main), fetching that branch first when `fetch`.
 * `sha` is the checkout's HEAD. Eligible means HEAD is on that branch, tracked files are clean and every local commit is
 * on origin, so a fast-forward is possible; otherwise `reason` says why not. A failed fetch is recorded, not thrown.
 */
export async function checkUpdate(repo: string, fetch: boolean): Promise<UpdateStatus> {
  const checkedAt = Date.now();
  const sha = (await tryGit(repo, 'rev-parse', 'HEAD')) ?? '';
  if (!(await tryGit(repo, 'remote', 'get-url', 'origin'))) return { sha, behind: 0, eligible: false, reason: 'no origin remote', checkedAt };
  const branch = (await tryGit(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'))?.replace(/^origin\//, '') || 'main';
  const fetchError = fetch ? await fetchBranch(repo, branch).then(() => undefined, firstLine) : undefined;
  const originSha = await tryGit(repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`);
  const head = await tryGit(repo, 'symbolic-ref', '--short', '-q', 'HEAD');
  const count = async (range: string) => Number(await tryGit(repo, 'rev-list', '--count', range)) || 0;
  const reason =
    head !== branch ? (head ? `on branch ${head}` : 'detached HEAD')
    : !originSha ? `no origin/${branch}`
    : (await tryGit(repo, 'status', '--porcelain', '--untracked-files=no')) ? 'uncommitted changes'
    : (await count(`origin/${branch}..HEAD`)) > 0 ? `local commits not on origin/${branch}`
    : undefined;
  const behind = originSha ? await count(`HEAD..origin/${branch}`) : 0;
  const newest = behind ? await tryGit(repo, 'log', '-1', '--format=%s', `origin/${branch}`) : undefined;
  return {
    sha, branch, ...(originSha ? { originSha } : {}), behind, ...(newest ? { newest } : {}), eligible: !reason, ...(reason ? { reason } : {}),
    checkedAt, ...(fetchError ? { fetchError } : {}),
  };
}

/** One line for `tl update --check` and the tool reply. */
export function updateLine(s: UpdateStatus): string {
  const fetched = s.fetchError ? ` (fetch failed: ${s.fetchError})` : '';
  if (!s.eligible) return `not eligible for updates: ${s.reason}${fetched}`;
  if (!s.behind) return `up to date with origin/${s.branch} at ${s.sha.slice(0, 7)}${fetched}`;
  return `${s.behind} commit${s.behind === 1 ? '' : 's'} behind origin/${s.branch}; newest: ${s.newest}${fetched}`;
}

/** What an update has to run besides the restart, from the paths it changed. The UI bundle is built from ui/ and src/shared/ with the installed packages. */
export function planSteps(changed: string[], appBuilt: boolean): { install: boolean; ui: boolean; app: boolean } {
  const any = (re: RegExp) => changed.some((p) => re.test(p));
  const install = any(/^package(-lock)?\.json$/);
  return { install, ui: install || any(/^(ui|src\/shared)\//), app: appBuilt && any(/^src-tauri\//) };
}

/**
 * The helper's work, logging to `log`: take the lock at `lock`, fast-forward to origin's branch, run npm ci and the
 * UI build as the changed paths need, then `restart` and release the lock. A failure before the restart moves the
 * checkout back to the old sha (git reset --keep) and reruns the npm steps that had started, so the code, packages and
 * UI bundle on disk match the running daemon, then throws without restarting; the error says when the rollback itself
 * failed. After the restart, an app build runs when src-tauri/ changed and Tiller.app exists; `notify` tells the human
 * how that went.
 */
export async function applyUpdate(o: {
  repo: string; log: string; lock: string; restart: () => Promise<void>; notify: (text: string) => void; env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const say = (s: string) => appendFileSync(o.log, `${new Date().toISOString()} tl update: ${s}\n`);
  const env = o.env ?? process.env;
  /** Run a command in the checkout with its output in the log; throw naming it when it fails or times out. */
  const run = (cmd: string, args: string[], timeout = GIT_TIMEOUT_MS, runEnv = env) => {
    say(`running ${cmd} ${args.join(' ')}`);
    const fd = openSync(o.log, 'a');
    try {
      const r = spawnSync(cmd, args, { cwd: o.repo, env: runEnv, stdio: ['ignore', fd, fd], timeout });
      if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.error?.message ?? `exit ${r.status ?? r.signal}`})`);
    } finally { closeSync(fd); }
  };

  const s = await checkUpdate(o.repo, false);
  if (!s.eligible) throw new Error(`not eligible: ${s.reason}`);
  if (!s.behind) { say('already up to date'); return; }
  const old = s.sha;
  try { writeFileSync(o.lock, JSON.stringify({ pid: process.pid, sha: old }), { flag: 'wx' }); } catch {
    throw new Error(`another update holds ${o.lock} (pid ${readLock(o.lock)?.pid ?? 'unknown'})`);
  }
  let plan: ReturnType<typeof planSteps>;
  try {
    /** The npm steps that started, so a rollback can redo them at the old sha. */
    const started: Array<{ args: string[]; timeout: number }> = [];
    const step = (args: string[], timeout: number) => { started.push({ args, timeout }); run('npm', args, timeout); };
    try {
      run('git', ['merge', '--ff-only', `origin/${s.branch}`]);
      const changed = (await git(o.repo, 'diff', '--name-only', old, 'HEAD')).split('\n').filter(Boolean);
      plan = planSteps(changed, existsSync(join(o.repo, APP_BUNDLE)));
      say(`updated ${short(old)}..${short(await git(o.repo, 'rev-parse', 'HEAD'))}, ${changed.length} file(s) changed`);
      // npm ci installs exactly what package-lock.json says and never rewrites it, so the checkout stays clean.
      if (plan.install) step(['ci'], CI_TIMEOUT_MS);
      if (plan.ui) step(['run', 'ui:build'], UI_TIMEOUT_MS);
    } catch (err) {
      const why = (err as Error).message;
      say(`${why}; moving the checkout back to ${short(old)} and leaving the daemon running`);
      try {
        if (await tryGit(o.repo, 'status', '--porcelain', '--', 'package-lock.json')) run('git', ['checkout', '--', 'package-lock.json']);
        run('git', ['reset', '--keep', old]);
      } catch (e) {
        const now = short((await tryGit(o.repo, 'rev-parse', 'HEAD')) ?? '?');
        say(`rollback failed: ${(e as Error).message}`);
        throw new Error(`update failed (${why}) and the rollback failed: the checkout is left at ${now} while the daemon runs ${short(old)}; see ${o.log}`);
      }
      // Best effort: node_modules and ui/dist go back to matching the code the running daemon serves.
      for (const { args, timeout } of started) {
        say(`rollback: rerunning npm ${args.join(' ')} at ${short(old)}`);
        try { run('npm', args, timeout); } catch (e) { say(`rollback: ${(e as Error).message}`); }
      }
      throw new Error(`${why}; the checkout is back at ${short(old)}, which the daemon runs; see ${o.log}`);
    }
    await o.restart();
  } finally {
    rmSync(o.lock, { force: true });
  }
  if (!plan.app) { say('done'); return; }
  // As bin/tl-app does: Homebrew's rustup is keg-only.
  const appEnv = { ...env, PATH: `/opt/homebrew/opt/rustup/bin:${env.PATH ?? ''}` };
  if (spawnSync('cargo', ['--version'], { env: appEnv }).status !== 0) {
    say('src-tauri changed but Rust (cargo) is not installed; install rustup, then run npm run app:build');
    o.notify('Tiller updated, but the app needs a rebuild and Rust is not installed: install rustup, then run npm run app:build.');
    return;
  }
  try {
    run('npm', ['run', 'app:build'], APP_TIMEOUT_MS, appEnv);
    say('app built; quit and reopen Tiller to use it');
    o.notify('Tiller app rebuilt: quit and reopen Tiller to use it.');
  } catch (err) {
    say((err as Error).message);
    o.notify(`Tiller updated, but the app build failed; see ${o.log}`);
  }
}

const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 6 * 3600_000;

export interface Updater {
  status(): UpdateStatus;
  /** Check now (fetching unless `fetch` is false) and tell onChange. Concurrent calls share one check. */
  check(fetch?: boolean): Promise<UpdateStatus>;
  /** Check from local refs now, fetch shortly after, then every 6 hours. */
  start(): void;
  /** Fetch, refuse unless eligible and behind, then hand off to the helper; resolves with its log path. */
  apply(): Promise<{ log: string; status: UpdateStatus }>;
}

/**
 * The daemon's view of updates. `sha` in the status is the sha this daemon started on, so a UI that reconnects to a
 * daemon on another sha knows to reload. `spawnHelper` starts `tl update --detached` and calls back when it exits, if
 * this daemon is still there to see it, which means it did not restart the daemon. A check that finds the helper's
 * lock left by a dead process removes it and reports the interrupted update.
 */
export function createUpdater(d: {
  repo: string; home: string; onChange: (s: UpdateStatus) => void;
  spawnHelper: (onExit: (code: number | null, signal: NodeJS.Signals | null) => void) => string;
}): Updater {
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: d.repo, encoding: 'utf8' }).stdout?.trim() ?? '';
  const [lockPath, logPath] = [join(d.home, UPDATE_LOCK), join(d.home, UPDATE_LOG)];
  let status: UpdateStatus = { sha, behind: 0, eligible: false, reason: 'not checked yet', checkedAt: 0 };
  /** From the moment apply is asked until its helper exits. */
  let inflight = false;
  const set = (s: UpdateStatus) => {
    const { applying: _, ...rest } = s;
    status = inflight ? { ...rest, applying: true } : rest;
    d.onChange(status);
    return status;
  };
  /** Remove a lock whose holder is dead and say so. */
  const staleLock = (): string | undefined => {
    if (!existsSync(lockPath) || lockHolder(lockPath)) return undefined;
    const l = readLock(lockPath);
    rmSync(lockPath, { force: true });
    return `a previous update${l ? ` from ${short(l.sha)}` : ''} was interrupted; see ${logPath}`;
  };
  let checking: Promise<UpdateStatus> | undefined;
  const check = (fetch = true) => checking ??= checkUpdate(d.repo, fetch)
    .then((s) => { const failed = staleLock() ?? status.failed; return set({ ...s, sha, ...(failed ? { failed } : {}) }); })
    .finally(() => { checking = undefined; });
  const quietly = (fetch: boolean) => void check(fetch).catch((err: Error) => console.error(`update check: ${err.message}`));
  /** What the user sees when the helper exits without restarting the daemon: its last `tl update:` line (the error it failed with). */
  const failure = (code: number | null, signal: NodeJS.Signals | null): string | undefined => {
    if (code === 0) return undefined; // already up to date: nothing changed
    let last: string | undefined;
    try { last = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.startsWith('tl update: ')).at(-1)?.slice('tl update: '.length); } catch { /* no log */ }
    const text = `update failed: ${last ?? (signal ? `the helper was killed (${signal})` : `the helper exited with code ${code}`)}`;
    return text.includes(logPath) ? text : `${text}; see ${logPath}`;
  };
  return {
    status: () => status,
    check,
    start() {
      quietly(false);
      setTimeout(() => quietly(true), FIRST_CHECK_MS).unref();
      setInterval(() => quietly(true), CHECK_EVERY_MS).unref();
    },
    async apply() {
      // Claim the update before anything awaits, so a second apply during the fetch is refused.
      if (inflight) throw new Error('an update is already running');
      const holder = lockHolder(lockPath);
      if (holder) throw new Error(`an update is already running (pid ${holder.pid}); see ${logPath}`);
      inflight = true;
      const { failed: _, ...rest } = status;
      set(rest);
      try {
        const s = await check();
        if (!s.eligible) throw new Error(`cannot update: ${s.reason}`);
        if (!s.behind) throw new Error(`already up to date with origin/${s.branch}`);
      } catch (err) {
        inflight = false;
        set(status);
        throw err;
      }
      const log = d.spawnHelper((code, signal) => {
        inflight = false;
        const { failed: _f, ...now } = status;
        const failed = failure(code, signal);
        set({ ...now, ...(failed ? { failed } : {}) });
      });
      return { log, status };
    },
  };
}
