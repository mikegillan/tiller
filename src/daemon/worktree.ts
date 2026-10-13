// Git helpers for per-node worktrees: <repo>/.claude/worktrees/<nodeId> on branch <prefix><nodeId>.
// Every git call goes through execFile with an argument array and a timeout. Only the setup and teardown commands from
// the config run through a shell (runCommands), by design.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { closeSync, existsSync, openSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Diff, DiffFile, Worktree } from '../shared/protocol.js';
import type { MergeStyle } from './config.js';

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
/** Checkout and copy can be slow on a large repo. */
const SLOW_TIMEOUT_MS = 5 * 60_000;
export const WORKTREES_DIR = join('.claude', 'worktrees');
const EXCLUDE_LINE = '/.claude/worktrees/';
const MARKER = 'o8-node';

export async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS, env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    return (await run('git', ['-C', cwd, ...args], { timeout, maxBuffer: 64 << 20, env })).stdout;
  } catch (err) {
    const e = err as Error & { stderr?: string };
    throw new Error(`git ${args[0]} failed: ${e.stderr?.trim() || e.message}`);
  }
}

/** The main checkout's root: the first entry of `git worktree list`, even when `cwd` is inside another worktree. */
export async function mainCheckout(cwd: string): Promise<string> {
  let out: string;
  try { out = await git(cwd, ['worktree', 'list', '--porcelain']); } catch { throw new Error(`not inside a git work tree: ${cwd}`); }
  const [first, second] = out.split('\n');
  if (second === 'bare') throw new Error(`a bare repository has no main checkout: ${cwd}`);
  return first!.slice('worktree '.length);
}

/** mainCheckout for synchronous callers: undefined outside a git work tree or in a bare repository. */
export function mainCheckoutSync(cwd: string): string | undefined {
  try {
    const [first, second] = execFileSync('git', ['-C', cwd, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n');
    return second === 'bare' ? undefined : first!.slice('worktree '.length);
  } catch {
    return undefined;
  }
}

/** The checkout's HEAD: its branch name (or the sha when detached) and sha. */
export async function headInfo(cwd: string): Promise<{ base: string; baseSha: string }> {
  let baseSha: string;
  try { baseSha = (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])).trim(); } catch { throw new Error(`${cwd} has no commits yet`); }
  const name = (await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
  return { base: name || baseSha, baseSha };
}

export const add = (repo: string, path: string, branch: string, baseSha: string) =>
  git(repo, ['worktree', 'add', '-q', '-b', branch, path, baseSha], SLOW_TIMEOUT_MS);

export const remove = (repo: string, path: string, force: boolean) =>
  git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);

export const prune = (repo: string) => git(repo, ['worktree', 'prune']);

export const branchExists = (repo: string, branch: string) =>
  git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).then(() => true, () => false);

/** -D: callers delete only after their own merged check, or on an explicit discard. `-d` would test against the main checkout's HEAD, not the base. */
export const deleteBranch = (repo: string, branch: string) => git(repo, ['branch', '-D', branch]);

/** Local branches whose name starts with `prefix`. */
export async function branches(repo: string, prefix: string): Promise<string[]> {
  return (await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).split('\n').filter((b) => b.startsWith(prefix));
}

export interface WorktreeEntry {
  path: string;
  /** Short branch name; absent when detached. */
  branch?: string;
  /** The lock reason ('' for a lock without one); absent when not locked. */
  locked?: string;
}

export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  return (await git(repo, ['worktree', 'list', '--porcelain'])).split('\n\n').filter(Boolean).map((block) => {
    const e: WorktreeEntry = { path: '' };
    for (const line of block.split('\n')) {
      const [key, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (key === 'worktree') e.path = value;
      else if (key === 'branch') e.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'locked') e.locked = value;
    }
    return e;
  });
}

/** Uncommitted changes as `git status --porcelain` lines: modified, staged and untracked files, not ignored ones. */
export async function dirtyFiles(path: string): Promise<string[]> {
  return (await git(path, ['status', '--porcelain'])).split('\n').filter(Boolean);
}

/**
 * The branch's commits that are not in `base`, as "sha subject" lines; empty means merged. Merged is: the branch is an
 * ancestor of base, or has no commits beyond baseSha, or every commit is patch-equivalent to one in base (git cherry).
 * A base that no longer resolves falls back to baseSha.
 */
export async function unmergedCommits(repo: string, branch: string, base: string, baseSha: string): Promise<string[]> {
  const target = await resolveBase(repo, base, baseSha);
  if (await isAncestor(repo, branch, target)) return [];
  if (!(await hasCommits(repo, branch, baseSha))) return [];
  return (await git(repo, ['cherry', '-v', target, branch])).split('\n').filter((l) => l.startsWith('+ ')).map((l) => l.slice(2));
}

const resolveBase = (repo: string, base: string, baseSha: string) =>
  git(repo, ['rev-parse', '--verify', '-q', `${base}^{commit}`]).then((s) => s.trim(), () => baseSha);

const isAncestor = (repo: string, a: string, b: string) => git(repo, ['merge-base', '--is-ancestor', a, b]).then(() => true, () => false);

/** Patch text a diff carries before the remaining files are listed without one. */
export const MAX_PATCH_BYTES = 2 << 20;

/**
 * Run `git diff` once per entry of `runs` over everything a worktree node changed since it branched: its commits and its
 * uncommitted and untracked files, as one diff of the working tree against the merge base with baseSha. The working tree
 * is staged into a throwaway copy of the index, so the node's own index is never touched. A missing worktree diffs the
 * branch alone. prune: git output above 64 MB (git()'s maxBuffer) fails the request; stream it if diffs get that large.
 */
async function nodeDiff(w: Worktree, runs: string[][]): Promise<string[]> {
  const common = ['diff', '--no-color', '--no-ext-diff', '-M'];
  if (!existsSync(w.path)) return Promise.all(runs.map((args) => git(w.repo, [...common, ...args, `${w.baseSha}...${w.branch}`])));
  const dir = await mkdtemp(join(tmpdir(), 'o8-diff-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
    const [index, mergeBase] = await Promise.all([
      git(w.path, ['rev-parse', '--git-path', 'index']).then((p) => resolve(w.path, p.trim())),
      git(w.path, ['merge-base', w.baseSha, 'HEAD']).then((s) => s.trim()),
    ]);
    await cp(index, env.GIT_INDEX_FILE).catch(() => {}); // no index yet: add builds one
    await git(w.path, ['add', '-A'], GIT_TIMEOUT_MS, env);
    return await Promise.all(runs.map((args) => git(w.path, [...common, '--cached', ...args, mergeBase], GIT_TIMEOUT_MS, env)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** `git diff --numstat -z` records: path (the new one for a rename) and line counts; binary files count as 0 and 0. */
function numstat(out: string): { path: string; additions: number; deletions: number; binary: boolean }[] {
  const tok = out.split('\0');
  const files = [];
  for (let i = 0; i < tok.length - 1; i++) {
    const [a, d, path] = tok[i]!.split('\t');
    files.push({ path: path || tok[(i += 2)]!, additions: Number(a) || 0, deletions: Number(d) || 0, binary: a === '-' });
  }
  return files;
}

/** Lines a worktree node added and removed: the totals of its Diff. */
export async function diffStat(w: Worktree): Promise<{ additions: number; deletions: number }> {
  const [out] = await nodeDiff(w, [['--numstat', '-z']]);
  return numstat(out!).reduce((t, f) => ({ additions: t.additions + f.additions, deletions: t.deletions + f.deletions }), { additions: 0, deletions: 0 });
}

/** A worktree node's diff, file by file; patches stop once they would pass MAX_PATCH_BYTES. */
export async function diff(w: Worktree): Promise<Diff> {
  const [stat, patch] = await nodeDiff(w, [['--numstat', '-z'], []]);
  // Both come from the same diff, so they list files in the same order: the nth section is the nth numstat record.
  const sections = patch!.split(/^(?=diff --git )/m).filter(Boolean);
  let bytes = 0, truncated = false;
  const files = numstat(stat!).map(({ binary, ...f }, i): DiffFile => {
    const text = sections[i] ?? '';
    const status = /^new file mode/m.test(text) ? 'added' : /^deleted file mode/m.test(text) ? 'deleted' : /^rename from/m.test(text) ? 'renamed' : 'modified';
    if (binary) return { ...f, status, binary };
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_PATCH_BYTES) { truncated = true; return { ...f, status }; }
    return { ...f, status, patch: text };
  });
  return { base: w.base, branch: w.branch, files, ...(truncated ? { truncated } : {}) };
}

/** Commits on the branch that are not in base (baseSha when base no longer resolves), and the reverse. */
export async function aheadBehind(repo: string, branch: string, base: string, baseSha: string): Promise<{ ahead: number; behind: number }> {
  const out = await git(repo, ['rev-list', '--left-right', '--count', `${await resolveBase(repo, base, baseSha)}...${branch}`]);
  const [behind, ahead] = out.trim().split(/\s+/).map(Number);
  return { ahead: ahead!, behind: behind! };
}

/** Merge `ours` and `theirs` in memory (no working tree, index or ref is touched): the merged tree, or the conflicting paths. */
export async function mergeTree(repo: string, ours: string, theirs: string): Promise<{ tree: string; conflicts: string[] }> {
  try {
    const { stdout } = await run('git', ['-C', repo, 'merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs], { timeout: SLOW_TIMEOUT_MS, maxBuffer: 64 << 20 });
    return { tree: stdout.trim(), conflicts: [] };
  } catch (err) {
    const e = err as Error & { code?: unknown; stdout?: string; stderr?: string };
    if (e.code !== 1 || !e.stdout) throw new Error(`git merge-tree failed: ${e.stderr?.trim() || e.message}`);
    const [tree, ...conflicts] = e.stdout.split('\n').filter(Boolean); // exit 1: conflicts, listed after the tree
    return { tree: tree!, conflicts };
  }
}

/** A merge refused because the branch conflicts with its base; `conflicts` holds the paths. */
export class MergeConflict extends Error {
  constructor(message: string, readonly conflicts: string[]) { super(message); }
}

/**
 * Bring `branch` into the local branch `base`, refusing before anything changes when they conflict. merge makes a merge
 * commit even when a fast-forward would do; squash makes one commit on base with the branch's changes; ff-only moves
 * base only when it has not moved since the branch left it. Where base is checked out, that checkout must have no
 * uncommitted changes to tracked files and is fast-forwarded to the result; elsewhere the ref moves atomically, and
 * only if base is still where it was. Returns base's new sha.
 */
export async function mergeInto(repo: string, branch: string, base: string, style: MergeStyle, subject: string): Promise<string> {
  const ref = `refs/heads/${base}`;
  const baseTip = await git(repo, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).then((s) => s.trim(), () => { throw new Error(`base ${base} is not a local branch; merge ${branch} by hand`); });
  const tip = (await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`])).trim();
  if (await isAncestor(repo, tip, baseTip)) throw new Error(`nothing to merge: ${branch} is already in ${base}`);
  let next = tip;
  if (style === 'ff-only') {
    if (!(await isAncestor(repo, baseTip, tip))) throw new Error(`cannot fast-forward ${base}: it has moved on since ${branch} left it; rebase the branch or use merge style "merge"`);
  } else {
    const { tree, conflicts } = await mergeTree(repo, baseTip, tip);
    if (conflicts.length) throw new MergeConflict(`merge refused, nothing changed: ${branch} conflicts with ${base} in ${conflicts.join(', ')}`, conflicts);
    const log = style === 'squash' ? await git(repo, ['log', '--reverse', '--format=* %s', `${baseTip}..${tip}`]) : '';
    const parents = style === 'merge' ? ['-p', baseTip, '-p', tip] : ['-p', baseTip];
    next = (await git(repo, ['commit-tree', tree, ...parents, '-m', subject, ...(log ? ['-m', log.trim()] : [])])).trim();
  }
  const checkout = (await listWorktrees(repo)).find((e) => e.branch === base);
  if (checkout) {
    if ((await git(checkout.path, ['status', '--porcelain', '--untracked-files=no'])).trim()) {
      throw new Error(`merge refused, nothing changed: ${base} is checked out at ${checkout.path} with uncommitted changes; commit or stash them first`);
    }
    await git(checkout.path, ['merge', '--ff-only', '-q', next]);
  } else {
    await git(repo, ['update-ref', '-m', `orchestr8: merge ${branch}`, ref, next, baseTip]);
  }
  return next;
}

/**
 * Run each command with `sh -c` in `cwd`, in order, appending its output to `log` (discarded when absent). Rejects on
 * the first that exits non-zero, runs past `timeout` or is aborted through `signal`.
 */
export async function runCommands(cmds: string[], o: { cwd: string; env: Record<string, string>; log?: string; timeout: number; signal?: AbortSignal; onStart?: (cmd: string) => void }): Promise<void> {
  const fd = o.log ? openSync(o.log, 'a', 0o600) : undefined;
  try {
    for (const cmd of cmds) {
      o.onStart?.(cmd);
      if (fd !== undefined) writeSync(fd, `$ ${cmd}\n`);
      const out = fd ?? 'ignore';
      const end = await new Promise<number | string>((done, fail) => {
        const p = spawn('sh', ['-c', cmd], { cwd: o.cwd, env: o.env, stdio: ['ignore', out, out], timeout: o.timeout, signal: o.signal });
        p.on('error', fail);
        p.on('close', (code, sig) => done(code ?? sig ?? 'unknown'));
      });
      if (end !== 0) throw new Error(`${cmd}: ${typeof end === 'number' ? `exited with ${end}` : `stopped by ${end} (time limit ${o.timeout / 60_000} minutes)`}`);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Whether the branch has commits beyond baseSha. */
export async function hasCommits(repo: string, branch: string, baseSha: string): Promise<boolean> {
  return (await git(repo, ['rev-list', '--count', `${baseSha}..${branch}`])).trim() !== '0';
}

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** A lock Claude took for session `id` ("claude session <id> (pid N start …)") whose process is gone: ours to lift. */
export function staleClaudeLock(reason: string, id: string): boolean {
  const m = /^claude session (\S+) \(pid (\d+)/.exec(reason);
  return !!m && m[1] === id && !pidAlive(Number(m[2]));
}

/** Lift a stale Claude lock on `path` so it can be removed. Any other lock is the user's: refuse. */
export async function unlockForRemoval(repo: string, path: string, id: string): Promise<void> {
  const e = (await listWorktrees(repo)).find((w) => w.path === path);
  if (e?.locked === undefined) return;
  if (!staleClaudeLock(e.locked, id)) throw new Error(`worktree ${path} is locked (${e.locked || 'no reason given'}); run git worktree unlock ${path} once nothing uses it`);
  await git(repo, ['worktree', 'unlock', path]);
}

/** Hide .claude/worktrees from the main checkout's `git status` through info/exclude (local, untracked), once. */
export async function ensureExcluded(repo: string): Promise<void> {
  const file = join((await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(), 'info', 'exclude');
  const text = await readFile(file, 'utf8').catch(() => '');
  if (text.split('\n').includes(EXCLUDE_LINE)) return;
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${text && !text.endsWith('\n') ? '\n' : ''}${EXCLUDE_LINE}\n`);
}

/** Written to .git/worktrees/<id>/o8-node; `home` keeps a test daemon from claiming the real daemon's worktrees. */
export interface Marker { home: string; nodeId: string; base: string; baseSha: string }

const adminDir = async (path: string) => (await git(path, ['rev-parse', '--path-format=absolute', '--git-dir'])).trim();

export async function writeMarker(path: string, m: Marker): Promise<void> {
  await writeFile(join(await adminDir(path), MARKER), JSON.stringify(m));
}

export async function readMarker(path: string): Promise<Marker | undefined> {
  try { return JSON.parse(await readFile(join(await adminDir(path), MARKER), 'utf8')) as Marker; } catch { return undefined; }
}

/**
 * Copy into `dest` the untracked files in `repo` that both match the include patterns (`patterns`, else the repo's
 * .worktreeinclude) and are gitignored, so tracked or merely untracked files are never copied. Returns the copied paths.
 */
export async function copyIncluded(repo: string, dest: string, patterns?: string[]): Promise<string[]> {
  let from = join(repo, '.worktreeinclude');
  let tmp: string | undefined;
  if (patterns) {
    tmp = await mkdtemp(join(tmpdir(), 'o8-include-'));
    from = join(tmp, 'patterns');
    await writeFile(from, `${patterns.join('\n')}\n`);
  } else if (!existsSync(from)) {
    return [];
  }
  try {
    const ls = async (exclude: string) => (await git(repo, ['ls-files', '-z', '--others', '--ignored', '--directory', exclude])).split('\0').filter(Boolean);
    const [wanted, ignored] = await Promise.all([ls(`--exclude-from=${from}`), ls('--exclude-standard')]);
    const ign = new Set(ignored);
    // The ignored listing collapses wholly ignored directories ("config/"), so an entry also counts when a directory above it is listed.
    const isIgnored = (p: string) => ign.has(p) || parentDirs(p).some((d) => ign.has(d));
    const picked = wanted.filter((p) => !p.startsWith('.claude/worktrees/') && isIgnored(p));
    for (const p of picked) await copyEntry(join(repo, p), join(dest, p));
    return picked;
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}

/** "a/b/c" gives ["a/", "a/b/"]. */
function parentDirs(p: string): string[] {
  const parts = p.replace(/\/$/, '').split('/').slice(0, -1);
  return parts.map((_, i) => `${parts.slice(0, i + 1).join('/')}/`);
}

/** APFS clone on macOS (near instant, copy-on-write), else a plain recursive copy. Symlinks stay links either way. */
async function copyEntry(src: string, dst: string): Promise<void> {
  src = src.replace(/\/$/, '');
  dst = dst.replace(/\/$/, '');
  await mkdir(dirname(dst), { recursive: true });
  if (process.platform === 'darwin') {
    try { await run('cp', ['-cRP', src, dst], { timeout: SLOW_TIMEOUT_MS }); return; } catch { /* not APFS, or cp failed: fall through */ }
  }
  await cp(src, dst, { recursive: true, verbatimSymlinks: true, force: true });
}
