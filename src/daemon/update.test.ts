import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyUpdate, checkUpdate, compareVersions, createUpdater, githubReleases, githubRepo, type PublishedRelease, type ReleaseSource } from './update.js';
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
}).trim();
let dir: string, seed: string, work: string, rows: PublishedRelease[], source: ReleaseSource;
const commit = (path: string, text = path) => { writeFileSync(join(seed, path), text); git(seed, 'add', path); git(seed, 'commit', '-qm', text); };
const release = (tag: string) => {
  git(seed, 'tag', tag); git(seed, 'push', '-q', 'origin', 'main', '--tags');
  const r = { id: rows.length + 1, tag, name: tag, body: `Notes for ${tag}`, publishedAt: '2026-10-17T00:00:00Z' }; rows.push(r); return r;
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tiller-release-test-'));
  git(dir, 'init', '-q', '--bare', '--initial-branch=main', 'origin.git');
  git(dir, 'clone', '-q', 'origin.git', 'seed'); seed = join(dir, 'seed');
  rows = []; source = { transport: join(dir, 'origin.git'), list: async () => [...rows], get: async (_repo, id) => rows.find((r) => r.id === id)! };
  commit('README', 'first'); release('v0.1.0');
  git(dir, 'clone', '-q', 'origin.git', 'work'); work = join(dir, 'work');
  git(work, 'remote', 'set-url', 'origin', 'https://github.com/example/tiller.git');

});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('published releases', () => {
  it('accepts only safe GitHub repository origins', () => {
    for (const url of ['https://github.com/a/b.git', 'git@github.com:a/b.git', 'ssh://git@github.com/a/b']) expect(githubRepo(url)).toBe('a/b');
    for (const url of ['https://github.com.evil/a/b', 'https://token@github.com/a/b', 'file:///a/b', 'https://github.com/a/b?x=1', 'https://github.com/a/..', 'git@evil:a/b']) expect(githubRepo(url)).toBeUndefined();
  });
  it('orders numeric semver without unsafe number conversion', () => {
    expect(compareVersions('v0.10.0', 'v0.9.99')).toBe(1);
    expect(compareVersions('v999999999999999999999.0.0', 'v2.0.0')).toBe(1);
    expect(() => compareVersions('v01.0.0', 'v1.0.0')).toThrow();
  });
  it('filters drafts, prereleases and invalid versions; handles rate limits and invalid responses', async () => {
    const row = { id: 1, tag_name: 'v0.1.0', name: null, body: 'notes', draft: false, prerelease: false, published_at: '2026-10-17T00:00:00Z' };
    const request = vi.fn(async () => new Response(JSON.stringify([row, { ...row, id: 2, draft: true }, { ...row, id: 3, prerelease: true }, { ...row, tag_name: 'main' }])));
    expect(await githubReleases(request as typeof fetch).list('a/b')).toEqual([{ id: 1, tag: 'v0.1.0', name: 'v0.1.0', body: 'notes', publishedAt: row.published_at }]);
    const limited = githubReleases((async () => new Response('', { status: 429 })) as typeof fetch);
    await expect(limited.list('a/b')).rejects.toThrow('rate limit');
    await expect(githubReleases((async () => new Response('{}')) as typeof fetch).list('a/b')).rejects.toThrow('invalid');
  });
});

describe('release checkout', () => {
  it('pins the latest release and rolls up missed notes without following unreleased main', async () => {
    commit('two'); release('v0.1.1'); commit('three'); release('v0.1.2');
    const target = git(seed, 'rev-parse', 'HEAD'); commit('unreleased'); git(seed, 'push', '-q', 'origin', 'main');
    const s = await checkUpdate(work, source);
    expect(s).toMatchObject({ eligible: true, currentVersion: 'v0.1.0', target: { tag: 'v0.1.2', sha: target } });
    expect(s.releases.map((r) => r.tag)).toEqual(['v0.1.2', 'v0.1.1']);
    const config = readFileSync(join(work, '.git/config'), 'utf8');
    await applyUpdate({ repo: work, log: join(dir, 'update.log'), expected: s, source });
    expect(git(work, 'rev-parse', 'HEAD')).toBe(target);
    expect(readFileSync(join(work, '.git/config'), 'utf8')).toBe(config);
    expect(git(work, 'status', '--porcelain')).toBe('');
  });
  it('preserves ignored local files when the release begins tracking their path', async () => {
    commit('.gitignore', 'private\n'); release('v0.1.1');
    git(work, 'merge', '--ff-only', (await checkUpdate(work, source)).target!.sha);
    writeFileSync(join(work, 'private'), 'keep my data');
    writeFileSync(join(seed, 'private'), 'release data'); git(seed, 'add', '-f', 'private'); git(seed, 'commit', '-qm', 'track private'); release('v0.1.2');
    const s = await checkUpdate(work, source);
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source })).rejects.toThrow('merge');
    expect(readFileSync(join(work, 'private'), 'utf8')).toBe('keep my data');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(s.sha);
  });
  it('revalidates tags immediately before apply after the release API check', async () => {
    commit('two'); release('v0.1.1'); const s = await checkUpdate(work, source);
    const get = source.get;
    source.get = async (repository, id) => {
      commit('three'); git(seed, 'tag', '-f', 'v0.1.1'); git(seed, 'push', '-q', '--force', 'origin', 'v0.1.1');
      return get(repository, id);
    };
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source })).rejects.toThrow('released tag moved');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(s.sha);
  });
  it('requires another review if a missed release body changes', async () => {
    commit('two'); const missed = release('v0.1.1'); commit('three'); release('v0.1.2');
    const s = await checkUpdate(work, source); missed.body = 'edited missed notes';
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source })).rejects.toThrow('release or checkout changed');
  });
  it('does not apply insteadOf twice when the first rewrite remains canonical', async () => {
    git(work, 'config', 'url.git@github.com:example/tiller.git.insteadOf', 'https://github.com/example/tiller.git');
    git(work, 'config', `url.${join(dir, 'origin.git')}.insteadOf`, 'git@github.com:example/tiller.git');
    git(work, 'config', 'protocol.ssh.allow', 'never'); // The regression must never contact a live provider.
    const s = await checkUpdate(work, { ...source, transport: undefined });
    expect(s.eligible).toBe(false);
    expect(s.target).toBeUndefined();
    expect(s.fetchError).toContain("transport 'ssh' not allowed");
  });
  it('rejects an effective origin rewritten to a different transport', async () => {
    git(work, 'config', `url.${join(dir, 'origin.git')}.insteadOf`, 'https://github.com/example/tiller.git');
    expect(await checkUpdate(work, { ...source, transport: undefined })).toMatchObject({ eligible: false, fetchError: 'effective origin transport does not match the GitHub release repository' });
  });
  it('never falls back when no releases or offline', async () => {
    expect(await checkUpdate(work, { ...source, list: async () => [] })).toMatchObject({ eligible: false, reason: 'no published stable releases' });
    expect(await checkUpdate(work, { ...source, list: async () => { throw new Error('offline'); } })).toMatchObject({ eligible: false, fetchError: 'offline' });
  });
  it('blocks dirty, untracked, local commits, detached and linked worktrees', async () => {
    commit('two'); release('v0.1.1');
    writeFileSync(join(work, 'local'), 'keep'); expect((await checkUpdate(work, source)).reason).toContain('untracked'); rmSync(join(work, 'local'));
    writeFileSync(join(work, 'README'), 'keep'); expect((await checkUpdate(work, source)).reason).toContain('uncommitted'); git(work, 'checkout', '--', 'README');
    git(work, 'commit', '--allow-empty', '-qm', 'local'); expect((await checkUpdate(work, source)).reason).toContain('local or unreleased');
    git(work, 'checkout', '--detach', '-q'); expect((await checkUpdate(work, source)).reason).toContain('main branch');
    git(work, 'checkout', '-q', 'main');
    const linked = join(dir, 'linked'); git(work, 'worktree', 'add', '-q', '--detach', linked);
    expect((await checkUpdate(linked, source)).eligible).toBe(false);
  });
  it('refuses a moved tag and changed release notes at apply', async () => {
    commit('two'); const r = release('v0.1.1'); const s = await checkUpdate(work, source);
    r.body = 'changed';
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source })).rejects.toThrow('release or checkout changed');
    r.body = 'Notes for v0.1.1'; commit('three'); git(seed, 'tag', '-f', r.tag); git(seed, 'push', '-q', '--force', 'origin', r.tag);
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source })).rejects.toThrow('release or checkout changed');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(s.sha);
  });
  it('reports an incomplete artifact rollback after restoring HEAD when both builds fail', async () => {
    mkdirSync(join(seed, 'ui')); commit('ui/app', 'old'); release('v0.1.1');
    git(work, 'merge', '--ff-only', (await checkUpdate(work, source)).target!.sha);
    commit('ui/app', 'new'); release('v0.1.2');
    const s = await checkUpdate(work, source), bin = join(dir, 'bin'); mkdirSync(bin);
    const builds = join(dir, 'builds');
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\ngit rev-parse HEAD >> '${builds}'\nexit 1\n`); chmodSync(join(bin, 'npm'), 0o755);
    const restart = vi.fn(async () => {});
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source, restart, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })).rejects.toThrow('rollback incomplete');
    expect(restart).not.toHaveBeenCalled();
    expect(git(work, 'rev-parse', 'HEAD')).toBe(s.sha);
    expect(readFileSync(builds, 'utf8').trim().split('\n')).toEqual([s.target!.sha, s.sha]);
    expect(existsSync(join(work, '.git/update.lock'))).toBe(false);
  });
  it('holds the checkout lock through verified restart and rolls back a failed restart', async () => {
    commit('two'); release('v0.1.1');
    const s = await checkUpdate(work, source), seen: string[] = [];
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source, restart: async (sha) => {
      expect(existsSync(join(work, '.git/update.lock'))).toBe(true);
      seen.push(sha);
      if (sha === s.target!.sha) throw new Error('health SHA mismatch');
    } })).rejects.toThrow('health SHA mismatch');
    expect(seen).toEqual([s.target!.sha, s.sha]);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(s.sha);
  });
  it('preserves edits made by a failing build when rollback cannot safely reset', async () => {
    mkdirSync(join(seed, 'ui')); commit('ui/app', 'old'); release('v0.1.1');
    git(work, 'merge', '--ff-only', (await checkUpdate(work, source)).target!.sha);
    commit('ui/app', 'new'); release('v0.1.2');
    const s = await checkUpdate(work, source), bin = join(dir, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho keep > ui/app\nexit 1\n'); chmodSync(join(bin, 'npm'), 0o755);
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })).rejects.toThrow('rollback incomplete');
    expect(readFileSync(join(work, 'ui/app'), 'utf8')).toBe('keep\n');
  });
  it('refuses restart and preserves a checkout moved by a build', async () => {
    mkdirSync(join(seed, 'ui')); commit('ui/app', 'new'); release('v0.1.1');
    const s = await checkUpdate(work, source), bin = join(dir, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\ngit checkout -qb user-branch\nexit 0\n'); chmodSync(join(bin, 'npm'), 0o755);
    const restart = vi.fn(async () => {});
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source, restart, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })).rejects.toThrow('HEAD or branch changed during update');
    expect(restart).not.toHaveBeenCalled();
    expect(git(work, 'symbolic-ref', '--short', 'HEAD')).toBe('user-branch');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(s.target!.sha);
  });
  it('refuses a surviving lock without removing it or changing HEAD', async () => {
    commit('two'); release('v0.1.1'); const s = await checkUpdate(work, source);
    const lock = join(work, '.git/update.lock'); writeFileSync(lock, 'interrupted');
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source })).rejects.toThrow('interrupted update holds');
    expect(readFileSync(lock, 'utf8')).toBe('interrupted');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(s.sha);
  });
  it('includes keg-only Homebrew cargo in forward and rollback app builds', async () => {
    mkdirSync(join(seed, 'src-tauri')); commit('src-tauri/config', 'old'); commit('.gitignore', 'src-tauri/target/\n'); release('v0.1.1');
    git(work, 'merge', '--ff-only', (await checkUpdate(work, source)).target!.sha);
    mkdirSync(join(work, 'src-tauri/target/release/bundle/macos/Tiller.app'), { recursive: true });
    commit('src-tauri/config', 'new'); release('v0.1.2');
    const s = await checkUpdate(work, source), bin = join(dir, 'bin'); mkdirSync(bin);
    const paths = join(dir, 'paths'), failed = join(dir, 'failed');
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$PATH" >> '${paths}'\nif [ ! -e '${failed}' ]; then touch '${failed}'; exit 1; fi\n`); chmodSync(join(bin, 'npm'), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source, env })).rejects.toThrow('npm run app:build failed');
    expect(readFileSync(paths, 'utf8').trim().split('\n')).toEqual([`/opt/homebrew/opt/rustup/bin:${env.PATH}`, `/opt/homebrew/opt/rustup/bin:${env.PATH}`]);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(s.sha);
  });
  it('uses a checkout-wide lock and rejects racing applies', async () => {
    commit('two'); release('v0.1.1');
    const helpers = vi.fn((_s: import('../shared/protocol.js').UpdateStatus, _exit: (code: number | null) => void) => join(dir, 'update.log'));
    const u = createUpdater({ repo: work, home: dir, source, onChange: () => {}, spawnHelper: helpers }); await u.check();
    const expected = { tag: u.status().target!.tag, sha: u.status().target!.sha };
    const results = await Promise.allSettled([u.apply(expected), u.apply(expected)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(helpers).toHaveBeenCalledTimes(1);
    expect(helpers.mock.calls[0][0]).toMatchObject({ target: { tag: expected.tag, sha: expected.sha } });
  });
});
