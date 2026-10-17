// Source-checkout updater. Release discovery never follows main or changes remote configuration.
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { ReleaseUpdate, UpdateStatus } from '../shared/protocol.js';

export const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const UPDATE_LOG = 'update.log';
export const UPDATE_LOCK = 'update.lock';
const exec = promisify(execFile);
const git = async (repo: string, ...args: string[]) => (await exec('git', args, {
  cwd: repo, timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' },
})).stdout.trim();
const tryGit = (repo: string, ...args: string[]) => git(repo, ...args).catch(() => undefined);
const version = (tag: string) => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag)?.slice(1).map(BigInt);
export function compareVersions(a: string, b: string): number {
  const av = version(a), bv = version(b);
  if (!av || !bv) throw new Error('release tags must use vX.Y.Z');
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] > bv[i] ? 1 : -1;
  return 0;
}
/** Accept only unambiguous GitHub origins; never send an origin URL or credentials to another host. */
export function githubRepo(origin: string): string | undefined {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(origin);
  return match && !['.', '..'].includes(match[2]) ? `${match[1]}/${match[2]}` : undefined;
}
export interface PublishedRelease { id: number; tag: string; name: string; body: string; publishedAt: string }
export interface ReleaseSource {
  /** Local fixture transport for tests; production always validates Git's effective GitHub URL. */
  transport?: string;
  list(repo: string): Promise<PublishedRelease[]>;
  get(repo: string, id: number): Promise<PublishedRelease>;
}
function published(value: unknown): PublishedRelease | undefined {
  if (!value || typeof value !== 'object') return;
  const r = value as Record<string, unknown>;
  if (r.draft !== false || r.prerelease !== false || typeof r.published_at !== 'string' || !Number.isFinite(Date.parse(r.published_at))
    || typeof r.id !== 'number' || !Number.isSafeInteger(r.id) || r.id <= 0 || typeof r.tag_name !== 'string' || !version(r.tag_name)
    || (r.body !== null && typeof r.body !== 'string') || (r.name !== null && typeof r.name !== 'string')) return;
  return { id: r.id, tag: r.tag_name, name: (r.name as string) || r.tag_name, body: (r.body as string) || '', publishedAt: r.published_at };
}
/** Public REST API, deliberately unauthenticated: no local tokens are sent to GitHub. */
export function githubReleases(request: typeof fetch = fetch): ReleaseSource {
  const json = async (path: string) => {
    const r = await request(`https://api.github.com/repos/${path}`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
    if (!r.ok) throw new Error(r.status === 403 || r.status === 429 ? 'GitHub rate limit or access denied; try again later' : `GitHub releases unavailable (HTTP ${r.status})`);
    return r.json() as Promise<unknown>;
  };
  return {
    async list(repo) {
      const releases: PublishedRelease[] = [];
      for (let page = 1; page <= 10; page++) {
        const rows = await json(`${repo}/releases?per_page=100&page=${page}`);
        if (!Array.isArray(rows)) throw new Error('invalid GitHub releases response');
        releases.push(...rows.flatMap((r) => { const p = published(r); return p ? [p] : []; }));
        if (rows.length < 100) return releases;
      }
      throw new Error('release history exceeds 1000 entries; cannot safely roll up notes');
    },
    async get(repo, id) {
      const release = published(await json(`${repo}/releases/${id}`));
      if (!release || release.id !== id) throw new Error('release is no longer published and stable');
      return release;
    },
  };
}
const ancestor = async (repo: string, a: string, b: string) => (await tryGit(repo, 'merge-base', '--is-ancestor', a, b)) !== undefined;
async function safeCheckout(repo: string): Promise<string | undefined> {
  if (await tryGit(repo, 'symbolic-ref', '--short', '-q', 'HEAD') !== 'main') return 'updates require the main branch';
  const common = await git(repo, 'rev-parse', '--git-common-dir');
  const dir = await git(repo, 'rev-parse', '--git-dir');
  if (resolve(repo, common) !== resolve(repo, dir)) return 'updates require the primary checkout, not a linked worktree';
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG'])
    if (existsSync(resolve(repo, await git(repo, 'rev-parse', '--git-path', name)))) return 'a git operation is in progress';
  if (await git(repo, 'status', '--porcelain', '--untracked-files=all')) return 'uncommitted or untracked files';
}
async function remoteTag(repo: string, origin: string, tag: string): Promise<string> {
  const refs = await git(repo, 'ls-remote', '--exit-code', '--refs', origin, `refs/tags/${tag}`);
  const [sha, ref] = refs.split(/\s+/);
  if (!/^[a-f0-9]{40,64}$/.test(sha) || ref !== `refs/tags/${tag}`) throw new Error(`cannot resolve released tag ${tag}`);
  return sha;
}
async function resolveRelease(repo: string, origin: string, release: PublishedRelease): Promise<ReleaseUpdate> {
  if (!version(release.tag)) throw new Error('invalid release tag');
  const tagObject = await remoteTag(repo, origin, release.tag);
  const ref = `refs/tiller/update/${randomUUID()}`;
  try {
    await git(repo, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', origin, `refs/tags/${release.tag}:${ref}`);
    if (await git(repo, 'rev-parse', ref) !== tagObject) throw new Error(`released tag ${release.tag} moved during fetch; check again`);
    const sha = await git(repo, 'rev-parse', `${ref}^{commit}`);
    return { ...release, sha, tagObject };
  } finally { await tryGit(repo, 'update-ref', '-d', ref); }
}
async function releaseTransport(repo: string, origin: string, repository: string, source?: ReleaseSource): Promise<string> {
  if (source?.transport) return source.transport;
  const effective = await git(repo, 'remote', 'get-url', 'origin');
  if (githubRepo(effective)?.toLowerCase() !== repository.toLowerCase()) throw new Error('effective origin transport does not match the GitHub release repository');
  // Feed Git the original URL so it applies exactly the one rewrite validated above.
  return origin;
}
export async function checkUpdate(repo: string, source: ReleaseSource = githubReleases()): Promise<UpdateStatus> {
  const sha = await tryGit(repo, 'rev-parse', 'HEAD') ?? '';
  const base: UpdateStatus = { sha, checkedAt: Date.now(), eligible: false, releases: [] };
  try {
    const origin = await git(repo, 'config', '--get', 'remote.origin.url');
    const repository = githubRepo(origin);
    if (!repository) return { ...base, reason: 'origin must identify a GitHub repository (HTTPS or git SSH)' };
    const transport = await releaseTransport(repo, origin, repository, source);
    const rows = (await source.list(repository)).sort((a, b) => compareVersions(b.tag, a.tag));
    if (!rows.length) return { ...base, reason: 'no published stable releases' };
    if (new Set(rows.map((r) => r.tag)).size !== rows.length) throw new Error('duplicate release tags');
    const target = await resolveRelease(repo, transport, rows[0]);
    const releases: ReleaseUpdate[] = [];
    let currentVersion: string | undefined;
    for (const row of rows) {
      const r = row.id === target.id ? target : await resolveRelease(repo, transport, row);
      if (await ancestor(repo, r.sha, sha)) { currentVersion = r.tag; break; }
      if (!(await ancestor(repo, r.sha, target.sha))) throw new Error(`${r.tag} is not in the latest release history`);
      releases.push(r);
    }
    const reason = await safeCheckout(repo)
      ?? (!(await ancestor(repo, sha, target.sha)) ? 'local or unreleased commits; latest release cannot fast-forward this checkout' : undefined)
      ?? (currentVersion && compareVersions(target.tag, currentVersion) < 0 ? 'latest release would downgrade this checkout' : undefined);
    return { ...base, repository, origin, target, currentVersion, releases, eligible: !reason, reason };
  } catch (e) { return { ...base, reason: 'release check unavailable; try again later', fetchError: (e as Error).message }; }
}
export function updateLine(s: UpdateStatus): string {
  const head = s.fetchError ? `${s.reason}: ${s.fetchError}` : !s.target ? s.reason : s.sha === s.target.sha
    ? `up to date at ${s.target.tag}` : `${s.target.tag} available (${s.target.sha.slice(0, 7)})${s.reason ? `; cannot update: ${s.reason}` : ''}`;
  return [head, ...s.releases.map((r) => `\n${r.tag} — ${r.name}\n${r.body || 'No release notes provided.'}`)].join('\n');
}
export function planSteps(changed: string[], appBuilt: boolean) {
  const install = changed.some((p) => /^package(-lock)?\.json$/.test(p));
  return { install, ui: install || changed.some((p) => /^(ui|src\/shared)\//.test(p)), app: appBuilt && changed.some((p) => /^src-tauri\//.test(p)) };
}
export async function applyUpdate(o: { repo: string; log: string; expected: UpdateStatus; restart?: (sha: string) => Promise<void>; source?: ReleaseSource; env?: NodeJS.ProcessEnv }): Promise<void> {
  // The git-common-dir lock excludes different daemons/TL_HOMEs using the same checkout.
  const lock = resolve(o.repo, await git(o.repo, 'rev-parse', '--git-common-dir'), UPDATE_LOCK);
  try { writeFileSync(lock, JSON.stringify({ pid: process.pid, sha: o.expected.sha }), { flag: 'wx' }); }
  catch { throw new Error(`another or interrupted update holds ${lock}; inspect ${o.log} before removing the lock`); }
  const say = (s: string) => appendFileSync(o.log, `${new Date().toISOString()} tl update: ${s}\n`);
  const started: string[][] = [];
  let moved = false;
  let restartAttempted = false;
  const run = async (cmd: string, args: string[], timeout = 60_000) => {
    say(`running ${cmd} ${args.join(' ')}`);
    try { const r = await exec(cmd, args, { cwd: o.repo, env: o.env ?? process.env, timeout, maxBuffer: 16 * 1024 * 1024 }); say(r.stdout + r.stderr); }
    catch (e) { const err = e as Error & { stdout?: string; stderr?: string }; say((err.stdout ?? '') + (err.stderr ?? '')); throw new Error(`${cmd} ${args.join(' ')} failed: ${err.message}`); }
  };
  try {
    const s = await checkUpdate(o.repo, o.source);
    const target = o.expected.target;
    if (!target || !s.target || !s.eligible || s.sha !== o.expected.sha || s.origin !== o.expected.origin
      || s.target.id !== target.id || s.target.tag !== target.tag || s.target.sha !== target.sha || s.target.tagObject !== target.tagObject || JSON.stringify(s.releases) !== JSON.stringify(o.expected.releases))
      throw new Error(`release or checkout changed; check again${s.reason ? `: ${s.reason}` : ''}`);
    if (s.sha === target.sha) throw new Error('already at the latest release');
    const publishedNow = await (o.source ?? githubReleases()).get(s.repository!, target.id);
    if (JSON.stringify(publishedNow) !== JSON.stringify({ id: target.id, tag: target.tag, name: target.name, body: target.body, publishedAt: target.publishedAt }))
      throw new Error('release changed; review its notes again');
    if (await remoteTag(o.repo, await releaseTransport(o.repo, s.origin!, s.repository!, o.source), target.tag) !== target.tagObject) throw new Error('released tag moved; check again');
    if (await safeCheckout(o.repo) || await git(o.repo, 'rev-parse', 'HEAD') !== s.sha) throw new Error('checkout changed; check again');
    const changed = (await git(o.repo, 'diff', '--name-only', s.sha, target.sha)).split('\n');
    const plan = planSteps(changed, existsSync(join(o.repo, 'src-tauri/target/release/bundle/macos/Tiller.app')));
    await run('git', ['merge', '--ff-only', '--no-edit', '--no-overwrite-ignore', target.sha]);
    moved = true;
    for (const [needed, args] of [[plan.install, ['ci']], [plan.ui, ['run', 'ui:build']], [plan.app, ['run', 'app:build']]] as const) {
      if (needed) { started.push([...args]); await run('npm', [...args], 30 * 60_000); }
    }
    if (await git(o.repo, 'rev-parse', 'HEAD') !== target.sha || await safeCheckout(o.repo)) throw new Error('checkout changed during build; refusing restart');
    if (o.restart) { restartAttempted = true; await o.restart(target.sha); }
    say(`updated to ${target.tag} at ${target.sha}`);
  } catch (e) {
    if (moved) {
      try {
        // --keep refuses to discard edits made during a build. Never reset a checkout someone moved.
        if (await git(o.repo, 'rev-parse', 'HEAD') !== o.expected.target!.sha || await tryGit(o.repo, 'symbolic-ref', '--short', '-q', 'HEAD') !== 'main') throw new Error('HEAD or branch changed during update');
        await run('git', ['reset', '--keep', o.expected.sha]);
        for (const args of started) await run('npm', args, 30 * 60_000);
        if (restartAttempted && o.restart) await o.restart(o.expected.sha);
      } catch (rollback) { throw new Error(`${(e as Error).message}; rollback incomplete: ${(rollback as Error).message}; see ${o.log}`); }
    }
    say((e as Error).message);
    throw e;
  } finally { rmSync(lock); }
}

/** Explicit reload must not race an updater changing this checkout. Stale locks require human inspection. */
export function updateLocked(repo: string): boolean {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim();
  return existsSync(resolve(repo, common, UPDATE_LOCK));
}

export function createUpdater(o: { repo: string; home: string; onChange(s: UpdateStatus): void; spawnHelper: (expected: UpdateStatus, onExit: (code: number | null) => void) => string; source?: ReleaseSource }) {
  const runtimeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: o.repo, encoding: 'utf8' }).trim();
  let status: UpdateStatus = { runtimeSha, sha: runtimeSha, checkedAt: 0, eligible: false, releases: [], reason: 'not checked yet' };
  let checking: Promise<UpdateStatus> | undefined;
  let applying = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const set = (s: UpdateStatus) => { status = { ...s, runtimeSha, applying }; o.onChange(status); return status; };
  const check = () => checking ??= checkUpdate(o.repo, o.source).then(set).finally(() => { checking = undefined; });
  return {
    status: () => status, check,
    start() { void check(); timer = setInterval(() => { if (!applying) void check(); }, 6 * 3600_000); timer.unref(); },
    stop() { if (timer) clearInterval(timer); },
    async apply(expected: { tag: string; sha: string }) {
      if (applying) throw new Error('an update is already running');
      if (!status.target || expected.tag !== status.target.tag || expected.sha !== status.target.sha) throw new Error('release changed; check and review again');
      if (!status.eligible) throw new Error(`cannot update: ${status.reason}`);
      if (status.sha === status.target.sha) throw new Error('already at the latest release');
      const approved = status;
      applying = true; set(status);
      const log = join(o.home, UPDATE_LOG);
      try {
        o.spawnHelper(approved, (code) => {
          applying = false;
          if (code !== 0) set({ ...status, failed: `update helper failed or was interrupted; see ${log}` });
          else void check();
        });
        return { log, status };
      } catch (e) { applying = false; set({ ...status, failed: (e as Error).message }); throw e; }
    },
  };
}
export type Updater = ReturnType<typeof createUpdater>;
