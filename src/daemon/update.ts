// Updating tiller from its own checkout: whether origin's default branch has commits this checkout can fast-forward
// to, and the detached `tl update --detached` helper that applies them, rebuilds what changed and restarts the daemon.
import { execFile, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { UpdateStatus } from '../shared/protocol.js';

/** The checkout this daemon's source lives in. */
export const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const APP_BUNDLE = 'src-tauri/target/release/bundle/macos/Tiller.app';
const GIT_TIMEOUT_MS = 60_000;
// A fetch must never wait for a password or a host-key prompt.
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
const exec = promisify(execFile);

const git = async (repo: string, ...args: string[]): Promise<string> =>
  (await exec('git', args, { cwd: repo, timeout: GIT_TIMEOUT_MS, env: { ...process.env, ...GIT_ENV } })).stdout.trim();
const tryGit = (repo: string, ...args: string[]) => git(repo, ...args).catch(() => undefined);
const firstLine = (e: { stderr?: string; message: string }) => (e.stderr?.trim() || e.message).split('\n')[0];

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
  const fetchError = fetch ? await git(repo, 'fetch', '--quiet', 'origin', branch).then(() => undefined, firstLine) : undefined;
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
 * The helper's work, logging to `log`: fast-forward to origin's branch, npm install and rebuild the UI as the changed
 * paths need, then `restart`. A failure before the restart moves the checkout back to the old sha (git reset --keep)
 * and reruns the npm steps that had started, so the code, packages and UI bundle on disk match the running daemon,
 * then throws without restarting. After the restart, an app build runs
 * when src-tauri/ changed and Tiller.app exists; `notify` tells the human how that went.
 */
export async function applyUpdate(o: {
  repo: string; log: string; restart: () => Promise<void>; notify: (text: string) => void; env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const say = (s: string) => appendFileSync(o.log, `${new Date().toISOString()} tl update: ${s}\n`);
  const env = o.env ?? process.env;
  /** Run a command in the checkout with its output in the log; throw naming it when it fails. */
  const run = (cmd: string, args: string[], runEnv = env) => {
    say(`running ${cmd} ${args.join(' ')}`);
    const fd = openSync(o.log, 'a');
    try {
      const r = spawnSync(cmd, args, { cwd: o.repo, env: runEnv, stdio: ['ignore', fd, fd] });
      if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.error?.message ?? `exit ${r.status ?? r.signal}`})`);
    } finally { closeSync(fd); }
  };

  const s = await checkUpdate(o.repo, false);
  if (!s.eligible) throw new Error(`not eligible: ${s.reason}`);
  if (!s.behind) { say('already up to date'); return; }
  const old = s.sha;
  let plan: ReturnType<typeof planSteps>;
  /** The npm steps that started, so a rollback can redo them at the old sha. */
  const started: string[][] = [];
  const step = (args: string[]) => { started.push(args); run('npm', args); };
  try {
    run('git', ['merge', '--ff-only', `origin/${s.branch}`]);
    const changed = (await git(o.repo, 'diff', '--name-only', old, 'HEAD')).split('\n').filter(Boolean);
    plan = planSteps(changed, existsSync(join(o.repo, APP_BUNDLE)));
    say(`updated ${old.slice(0, 7)}..${(await git(o.repo, 'rev-parse', 'HEAD')).slice(0, 7)}, ${changed.length} file(s) changed`);
    if (plan.install) step(['install']);
    if (plan.ui) step(['run', 'ui:build']);
  } catch (err) {
    say(`${(err as Error).message}; moving the checkout back to ${old.slice(0, 7)} and leaving the daemon running`);
    try {
      run('git', ['reset', '--keep', old]);
      // Best effort: node_modules and ui/dist go back to matching the code the running daemon serves.
      for (const args of started) {
        say(`rollback: rerunning npm ${args.join(' ')} at ${old.slice(0, 7)}`);
        try { run('npm', args); } catch (e) { say(`rollback: ${(e as Error).message}`); }
      }
    } catch (e) { say(`rollback failed: ${(e as Error).message}`); }
    throw err;
  }
  await o.restart();
  if (!plan.app) { say('done'); return; }
  // As bin/tl-app does: Homebrew's rustup is keg-only.
  const appEnv = { ...env, PATH: `/opt/homebrew/opt/rustup/bin:${env.PATH ?? ''}` };
  if (spawnSync('cargo', ['--version'], { env: appEnv }).status !== 0) {
    say('src-tauri changed but Rust (cargo) is not installed; install rustup, then run npm run app:build');
    o.notify('Tiller updated, but the app needs a rebuild and Rust is not installed: install rustup, then run npm run app:build.');
    return;
  }
  try {
    run('npm', ['run', 'app:build'], appEnv);
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
 * daemon on another sha knows to reload. `spawnHelper` starts `tl update --detached` and calls back with its exit code
 * if this daemon is still there to see it, which only a failure before the restart allows.
 */
export function createUpdater(d: { repo: string; onChange: (s: UpdateStatus) => void; spawnHelper: (onExit: (code: number | null) => void) => string }): Updater {
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: d.repo, encoding: 'utf8' }).stdout?.trim() ?? '';
  let status: UpdateStatus = { sha, behind: 0, eligible: false, reason: 'not checked yet', checkedAt: 0 };
  const set = (s: UpdateStatus) => { status = s; d.onChange(s); return s; };
  let checking: Promise<UpdateStatus> | undefined;
  const check = (fetch = true) => checking ??= checkUpdate(d.repo, fetch)
    .then((s) => set({ ...s, sha, ...(status.applying ? { applying: true } : {}), ...(status.failed ? { failed: status.failed } : {}) }))
    .finally(() => { checking = undefined; });
  const quietly = (fetch: boolean) => void check(fetch).catch((err: Error) => console.error(`update check: ${err.message}`));
  return {
    status: () => status,
    check,
    start() {
      quietly(false);
      setTimeout(() => quietly(true), FIRST_CHECK_MS).unref();
      setInterval(() => quietly(true), CHECK_EVERY_MS).unref();
    },
    async apply() {
      if (status.applying) throw new Error('an update is already running');
      const s = await check();
      if (!s.eligible) throw new Error(`cannot update: ${s.reason}`);
      if (!s.behind) throw new Error(`already up to date with origin/${s.branch}`);
      const log = d.spawnHelper((code) => {
        if (!code) return;
        const last = (() => { try { return readFileSync(log, 'utf8').trim().split('\n').at(-1); } catch { return undefined; } })();
        const { applying: _, ...rest } = status;
        set({ ...rest, failed: `update failed: ${last ?? `exit ${code}`}` });
      });
      const { failed: _, ...rest } = s;
      return { log, status: set({ ...rest, applying: true }) };
    },
  };
}
