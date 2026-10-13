// Worktree nodes against a throwaway git repo under the test's home, with a fake claude on PATH. Never this repo.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeManager, type SpawnRequest } from './manager.js';
import { mountMcp } from './mcp.js';
import * as wt from './worktree.js';

const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const commit = (dir: string, file: string) => { writeFileSync(join(dir, file), `${file}\n`); g(dir, 'add', file); g(dir, 'commit', '-qm', `add ${file}`); };

vi.setConfig({ testTimeout: 30_000 }); // dozens of git processes per test; slow on a loaded machine

let home = '', repo = '', m: NodeManager;

function setup(): void {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'o8-wt-')));
  vi.stubEnv('HOME', home); // trustPolicy reads ~/.claude.json; git then reads no global config
  repo = join(home, 'repo');
  mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) g(repo, 'config', k!, v!);
  commit(repo, 'README');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  // Fake claude: writes its cwd and argv next to the node's settings.json, then idles.
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nfor a in "$@"; do case "$prev" in --settings) out="$(dirname "$a")/argv";; esac; prev="$a"; done\n{ pwd; echo "$@"; } > "$out"\nexec sleep 30\n');
  chmodSync(join(bin, 'claude'), 0o755);
  m = new NodeManager({ home: join(home, 'o8'), shell: '/bin/sh', path: `${bin}:/usr/bin:/bin` });
}

const spawnW = (extra: Partial<SpawnRequest> = {}) => m.spawnWorktree({ kind: 'claude', title: 'w', cwd: repo, ...extra });
const exited = async (id: string) => { m.session(id)!.kill(); await expect.poll(() => m.view(id)!.status.exited).toBe(true); };

afterEach(() => {
  m?.shutdown();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('worktree nodes', () => {
  it('spawn creates the worktree, branch, marker and exclude line, and launches claude from the main checkout with --worktree', async () => {
    setup();
    const sha = g(repo, 'rev-parse', 'HEAD');
    const v = await spawnW();
    const path = join(repo, '.claude', 'worktrees', v.id);
    expect(v.cwd).toBe(path);
    expect(v.worktree).toEqual({ repo, path, branch: `o8/${v.id}`, base: 'main', baseSha: sha });
    expect(g(path, 'branch', '--show-current')).toBe(`o8/${v.id}`);
    expect(JSON.parse(readFileSync(join(repo, '.git', 'worktrees', v.id, 'o8-node'), 'utf8'))).toEqual({ home: m.home, nodeId: v.id, base: 'main', baseSha: sha });
    await spawnW(); // a second worktree does not add the line again
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').split('\n').filter((l) => l === '/.claude/worktrees/')).toHaveLength(1);
    expect(g(repo, 'status', '--porcelain')).toBe('');
    expect(JSON.parse(readFileSync(join(m.home, 'nodes', v.id, 'settings.json'), 'utf8')).worktree).toEqual({ baseRef: 'head' });
    const argv = join(m.home, 'nodes', v.id, 'argv');
    await expect.poll(() => (existsSync(argv) ? readFileSync(argv, 'utf8') : '')).toContain(`--worktree ${v.id}`);
    expect(readFileSync(argv, 'utf8').split('\n')[0]).toBe(repo);
  });

  it('refuses a terminal, a cwd outside git, a repo with no commits and an untrusted repo, leaving nothing behind', async () => {
    setup();
    await expect(m.spawnWorktree({ kind: 'terminal', title: 't', cwd: repo })).rejects.toThrow(/claude nodes only/);
    await expect(spawnW({ cwd: join(home, 'bin') })).rejects.toThrow(/not inside a git work tree/);
    const empty = join(home, 'empty');
    mkdirSync(empty);
    g(empty, 'init', '-q');
    await expect(spawnW({ cwd: empty })).rejects.toThrow(/no commits/);
    // A trusted ancestor is not enough: claude --worktree checks the repo's own entry.
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [home]: { hasTrustDialogAccepted: true }, [repo]: { hasTrustDialogAccepted: false } } }));
    await expect(spawnW()).rejects.toThrow(`run claude once in ${repo} to trust it`);
    expect(() => m.spawn({ kind: 'claude', title: 'c', cwd: repo, isolation: 'worktree' })).toThrow(/spawnWorktree/);
    expect(m.list()).toEqual([]);
    expect(g(repo, 'branch', '--list', 'o8/*')).toBe('');
  });

  it('close refuses a dirty or unmerged tree and one shared with a live node; keep commits WIP, removes the directory and keeps the branch', async () => {
    setup();
    const v = await spawnW();
    const path = v.cwd, branch = `o8/${v.id}`;
    commit(path, 'a.txt');
    writeFileSync(join(path, 'b.txt'), 'b\n');
    await expect(m.close(v.id, true)).rejects.toThrow(/^worktree kept: 1 dirty file, 1 unmerged commit; close with keep or discard$/);
    expect(m.session(v.id)).toBeDefined(); // a refused close leaves the node running
    const sharer = m.spawn({ kind: 'terminal', title: 's', cwd: path, parentId: v.id });
    await expect(m.close(v.id, true, 'discard')).rejects.toThrow(`worktree in use by ${sharer.id}; close those nodes first`);
    await expect(m.close(v.id, true)).rejects.toThrow(`worktree kept: 1 dirty file, 1 unmerged commit; close with keep or discard; in use by ${sharer.id}`);
    await m.close(sharer.id);

    expect(await m.close(v.id, true, 'keep')).toBe(`kept branch ${branch}`);
    expect(existsSync(path)).toBe(false);
    expect(m.view(v.id)).toBeUndefined();
    expect(g(repo, 'log', '-1', '--format=%s', branch)).toBe(`WIP: orchestr8 node "w" (${v.id})`);
    expect(g(repo, 'show', '--format=', '--name-only', branch)).toBe('b.txt');
    expect(g(repo, 'status', '--porcelain')).toBe(''); // the main checkout is untouched

    const report = await m.worktrees({ cwd: repo });
    expect(report.kept).toEqual([{ repo, branch, unmerged: [expect.stringContaining('add a.txt'), expect.stringContaining('WIP')] }]);
    expect((await m.worktrees({ cwd: repo, clean: 'safe' })).kept).toHaveLength(1); // unmerged: safe leaves it
    const forced = await m.worktrees({ cwd: repo, clean: 'force' });
    expect(forced.removed).toEqual([{ what: `branch ${branch} in ${repo}`, commits: report.kept[0]!.unmerged, files: [] }]);
    expect(g(repo, 'branch', '--list', branch)).toBe('');
  });

  it('close discard removes the worktree and the branch with their work', async () => {
    setup();
    const v = await spawnW();
    commit(v.cwd, 'a.txt');
    writeFileSync(join(v.cwd, 'b.txt'), 'b\n');
    expect(await m.close(v.id, true, 'discard')).toBeUndefined();
    expect(existsSync(v.cwd)).toBe(false);
    expect(g(repo, 'branch', '--list', `o8/${v.id}`)).toBe('');
  });

  it('close succeeds on a clean tree whose branch is merged, and deletes the branch', async () => {
    setup();
    const v = await spawnW();
    commit(v.cwd, 'a.txt');
    g(repo, 'merge', '-q', '--no-ff', '--no-edit', `o8/${v.id}`);
    await m.close(v.id, true);
    expect(existsSync(v.cwd)).toBe(false);
    expect(g(repo, 'branch', '--list', `o8/${v.id}`)).toBe('');
    expect(g(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('prune removes a clean exited worktree node and keeps one with unmerged work', async () => {
    setup();
    const busy = await spawnW(), idle = await spawnW();
    commit(busy.cwd, 'a.txt');
    await exited(busy.id);
    await exited(idle.id);
    const r = await m.prune();
    expect(r.removed).toEqual([idle.id]);
    expect(r.kept).toEqual([{ id: busy.id, reason: 'worktree kept: 0 dirty files, 1 unmerged commit; close with keep or discard' }]);
    expect(existsSync(busy.cwd)).toBe(true);
    expect(existsSync(idle.cwd)).toBe(false);
  });

  it('resume and restart are refused when the worktree directory is gone; close then drops the unused branch', async () => {
    setup();
    const v = await spawnW();
    await exited(v.id);
    rmSync(v.cwd, { recursive: true, force: true });
    expect(await m.resume(v.id)).toEqual({ ok: false, error: 'worktree missing' });
    expect(m.view(v.id)!.worktree!.missing).toBe(true);
    expect(m.restart(v.id)).toEqual({ ok: false, error: 'worktree missing' });
    await m.close(v.id, true);
    expect(g(repo, 'branch', '--list', `o8/${v.id}`)).toBe('');
  });

  it('startup reconciliation removes a clean orphan, lists one with work, and ignores worktrees with another home', async () => {
    setup();
    const node = await spawnW(); // also records the repo in worktree-repos.json
    const sha = g(repo, 'rev-parse', 'HEAD');
    const orphan = async (id: string, markerHome: string) => {
      const path = join(repo, '.claude', 'worktrees', id);
      await wt.add(repo, path, `o8/${id}`, sha);
      await wt.writeMarker(path, { home: markerHome, nodeId: id, base: 'main', baseSha: sha });
      return path;
    };
    const busy = await orphan('n-0000000a', m.home);
    commit(busy, 'x.txt');
    const idle = await orphan('n-0000000b', m.home);
    const foreign = await orphan('n-0000000c', '/another/home');
    const r = await m.worktrees({ clean: 'startup' });
    expect(r.removed.map((x) => x.what)).toEqual([`worktree ${idle} and branch o8/n-0000000b`]);
    expect(r.orphans).toEqual([expect.objectContaining({ nodeId: 'n-0000000a', path: busy, dirty: [], unmerged: [expect.stringContaining('add x.txt')] })]);
    expect(r.nodes.map((n) => n.nodeId)).toEqual([node.id]);
    expect(r.kept).toEqual([]);
    expect(existsSync(busy) && existsSync(foreign)).toBe(true);
  });

  it('an agent close of an unmerged worktree is refused even under approvals.close "done"; discard always asks', async () => {
    setup();
    mkdirSync(join(repo, '.orchestr8'));
    writeFileSync(join(repo, '.orchestr8', 'config.json'), JSON.stringify({ approvals: { close: 'done' } }));
    const confirms: string[] = [];
    const { handler } = mountMcp(m, async (t) => { confirms.push(t); return true; }, () => {});
    const server = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const parent = m.spawn({ kind: 'terminal', title: 'boss', cwd: repo });
      const kid = await spawnW({ parentId: parent.id });
      commit(kid.cwd, 'a.txt');
      await exited(kid.id);
      const close = async (args: object) => {
        const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/close`, {
          method: 'POST', headers: { Authorization: `Bearer ${m.tokenFor(parent.id)}`, 'X-O8-Node': parent.id }, body: JSON.stringify({ nodeIds: [kid.id], ...args }),
        });
        return (await res.json()) as { data?: unknown; error?: string };
      };
      expect((await close({})).error).toBe('worktree kept: 0 dirty files, 1 unmerged commit; close with keep or discard');
      expect(confirms).toEqual([]);
      expect(m.view(kid.id)).toBeDefined();
      expect((await close({ worktree: 'discard' })).data).toMatchObject({ ok: true });
      expect(confirms).toEqual([expect.stringContaining('discards 1 commit(s) and 0 changed file(s)')]);
      expect(existsSync(kid.cwd)).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});

describe('git state and merge', () => {
  const stop = (id: string) => m.applyHook(id, { hook_event_name: 'Stop' });
  const config = (worktrees: object) => writeFileSync(join(m.home, 'config.json'), JSON.stringify({ worktrees }));

  it('counts commits ahead and behind and dirty files, refreshed when a turn stops', async () => {
    setup();
    const v = await spawnW();
    await expect.poll(() => m.view(v.id)!.status.git).toEqual({ branch: `o8/${v.id}`, base: 'main', ahead: 0, behind: 0, dirty: 0, additions: 0, deletions: 0 });
    commit(v.cwd, 'a.txt');
    writeFileSync(join(v.cwd, 'b.txt'), 'b\n');
    commit(repo, 'c.txt');
    stop(v.id);
    await expect.poll(() => m.view(v.id)!.status.git).toEqual({ branch: `o8/${v.id}`, base: 'main', ahead: 1, behind: 1, dirty: 1, additions: 2, deletions: 0 });
  });

  it('diffs commits and uncommitted work as one, file by file, leaving the node\'s own index alone', async () => {
    setup();
    commit(repo, 'gone.txt');
    const v = await spawnW();
    writeFileSync(join(v.cwd, 'README'), 'README\nmore\n');
    g(v.cwd, 'commit', '-qam', 'edit');
    g(v.cwd, 'rm', '-q', 'gone.txt');
    writeFileSync(join(v.cwd, 'new.txt'), 'one\ntwo\n');
    const d = await m.diff(v.id);
    expect({ ...d, files: d.files.map(({ patch, ...f }) => f) }).toEqual({
      base: 'main', branch: `o8/${v.id}`, files: [
        { path: 'README', status: 'modified', additions: 1, deletions: 0 },
        { path: 'gone.txt', status: 'deleted', additions: 0, deletions: 1 },
        { path: 'new.txt', status: 'added', additions: 2, deletions: 0 },
      ],
    });
    expect(d.files[2]!.patch).toMatch(/^diff --git a\/new.txt b\/new.txt\n[^]*@@ -0,0 \+1,2 @@\n\+one\n\+two\n$/);
    expect(g(v.cwd, 'status', '--porcelain')).toBe('D  gone.txt\n?? new.txt');
  });

  it('lists binary files and files past the patch cap without a patch', async () => {
    setup();
    const v = await spawnW();
    writeFileSync(join(v.cwd, 'a.txt'), 'small\n');
    writeFileSync(join(v.cwd, 'b.bin'), Buffer.from([0, 1, 2, 0]));
    const lines = Math.ceil(wt.MAX_PATCH_BYTES / 100); // 100 bytes a line: the patch passes the cap
    writeFileSync(join(v.cwd, 'c.txt'), `${'y'.repeat(99)}\n`.repeat(lines));
    const d = await m.diff(v.id);
    expect(d.files.map((f) => [f.path, !!f.patch, !!f.binary])).toEqual([['a.txt', true, false], ['b.bin', false, true], ['c.txt', false, false]]);
    expect(d.truncated).toBe(true);
    expect(d.files[2]!.additions).toBe(lines);
  });

  it('refuses a diff for a node without a worktree', async () => {
    setup();
    const t = m.spawn({ kind: 'terminal', title: 't', cwd: repo });
    await expect(m.diff(t.id)).rejects.toThrow(`${t.id} has no worktree of its own to diff`);
  });

  it('refuses a conflicting merge, naming the paths and touching no file', async () => {
    setup();
    const v = await spawnW();
    writeFileSync(join(v.cwd, 'README'), 'theirs\n');
    g(v.cwd, 'commit', '-qam', 'theirs');
    writeFileSync(join(repo, 'README'), 'ours\n');
    g(repo, 'commit', '-qam', 'ours');
    const head = g(repo, 'rev-parse', 'HEAD');
    await expect(m.merge(v.id)).rejects.toMatchObject({ message: `merge refused, nothing changed: o8/${v.id} conflicts with main in README`, conflicts: ['README'] });
    expect(g(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(repo, 'README'), 'utf8')).toBe('ours\n');
    expect(g(repo, 'status', '--porcelain') + g(v.cwd, 'status', '--porcelain')).toBe('');
    expect(m.view(v.id)!.status.git?.mergedAt).toBeUndefined();
  });

  it('refuses a dirty tree; merges with a merge commit into the checked-out base and sets mergedAt; close then succeeds', async () => {
    setup();
    const v = await spawnW();
    commit(v.cwd, 'a.txt');
    writeFileSync(join(v.cwd, 'b.txt'), 'b\n');
    await expect(m.merge(v.id)).rejects.toThrow('1 uncommitted file in the worktree');
    rmSync(join(v.cwd, 'b.txt'));
    const r = await m.merge(v.id);
    expect(r).toEqual({ base: 'main', sha: g(repo, 'rev-parse', 'main'), style: 'merge' });
    expect(g(repo, 'log', '-1', '--format=%P').split(' ')).toHaveLength(2);
    expect(g(repo, 'log', '-1', '--format=%s')).toBe(`Merge branch 'o8/${v.id}': w`);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('a.txt\n'); // the main checkout moved with its branch
    expect(g(repo, 'status', '--porcelain')).toBe('');
    expect(m.view(v.id)!.status.git).toMatchObject({ ahead: 0, mergedAt: expect.any(Number) });
    await expect(m.merge(v.id)).rejects.toThrow('nothing to merge');
    await m.close(v.id, true);
    expect(g(repo, 'branch', '--list', `o8/${v.id}`)).toBe('');
  });

  it('squash makes one commit on base and the squashed branch still closes; ff-only refuses a moved base', async () => {
    setup();
    config({ mergeStyle: 'squash' });
    const v = await spawnW();
    commit(v.cwd, 'a.txt');
    commit(v.cwd, 'b.txt');
    const before = g(repo, 'rev-parse', 'main');
    await m.merge(v.id);
    expect(g(repo, 'log', '-1', '--format=%P')).toBe(before);
    expect(g(repo, 'log', '-1', '--format=%B')).toBe(`w (squashed from o8/${v.id})\n\n* add a.txt\n* add b.txt`);
    expect(g(repo, 'show', '--format=', '--name-only', 'main').split('\n')).toEqual(['a.txt', 'b.txt']);
    await m.close(v.id, true);
    expect(existsSync(v.cwd)).toBe(false);

    config({ mergeStyle: 'ff-only' });
    const f = await spawnW();
    commit(f.cwd, 'f.txt');
    commit(repo, 'moved.txt');
    await expect(m.merge(f.id)).rejects.toThrow('cannot fast-forward main');
    g(repo, 'reset', '-q', '--hard', 'HEAD~1');
    await m.merge(f.id);
    expect(g(repo, 'rev-parse', 'main')).toBe(g(repo, 'rev-parse', `o8/${f.id}`));
  });

  it('moves a base that is not checked out by ref only, and refuses a base checked out with uncommitted changes', async () => {
    setup();
    const v = await spawnW();
    commit(v.cwd, 'a.txt');
    writeFileSync(join(repo, 'README'), 'edited\n');
    await expect(m.merge(v.id)).rejects.toThrow(`main is checked out at ${repo} with uncommitted changes`);
    g(repo, 'checkout', '-q', '--', 'README');
    g(repo, 'switch', '-q', '-c', 'other');
    await m.merge(v.id);
    expect(g(repo, 'show', '--format=', '--name-only', 'main^2')).toBe('a.txt');
    expect(existsSync(join(repo, 'a.txt'))).toBe(false); // the checkout on "other" is untouched
    expect(g(repo, 'status', '--porcelain')).toBe('');
  });
});

describe('setup and teardown commands', () => {
  const config = (worktrees: object) => writeFileSync(join(m.home, 'config.json'), JSON.stringify({ worktrees }));
  const argvOf = (id: string) => { const f = join(m.home, 'nodes', id, 'argv'); return existsSync(f) ? readFileSync(f, 'utf8') : ''; };

  it('setup runs in the worktree with its env before launch; a failure marks the node and restart retries it', async () => {
    setup();
    config({ setup: ['sleep 0.5', 'echo "$O8_NODE_ID $O8_BASE $O8_REPO $O8_WORKTREE $(pwd)" > ../setup-$O8_NODE_ID'] });
    const v = await spawnW({ prompt: 'hi' });
    expect(v.status).toMatchObject({ state: 'unknown', activity: 'setting up worktree: sleep 0.5' });
    await expect(m.merge(v.id)).rejects.toThrow('worktree setup is running');
    expect(m.session(v.id)).toBeUndefined();
    await expect.poll(() => argvOf(v.id), { timeout: 5000 }).toContain('-- hi');
    expect(readFileSync(join(repo, '.claude', 'worktrees', `setup-${v.id}`), 'utf8')).toBe(`${v.id} main ${repo} ${v.cwd} ${v.cwd}\n`);

    config({ setup: ['echo broken; exit 3'] });
    const bad = await spawnW({ prompt: 'brief' });
    const log = join(m.home, 'nodes', bad.id, 'setup.log');
    await expect.poll(() => m.view(bad.id)!.status).toMatchObject({ exited: true, errored: true, activity: `worktree setup failed: echo broken; exit 3: exited with 3; see ${log}` });
    expect(readFileSync(log, 'utf8')).toBe('$ echo broken; exit 3\nbroken\n');
    expect(m.session(bad.id)).toBeUndefined();
    expect(await m.resume(bad.id)).toEqual({ ok: false, error: 'worktree setup has not succeeded; restart runs it again' });
    config({ setup: ['true'] });
    expect(m.restart(bad.id)).toEqual({ ok: true });
    await expect.poll(() => argvOf(bad.id), { timeout: 5000 }).toContain('-- brief');
  });

  it('teardown runs in the worktree before close removes it', async () => {
    setup();
    config({ teardown: ['echo "$O8_NODE_ID" >> "$O8_REPO/../teardown.log"; test -d "$O8_WORKTREE"'] });
    const v = await spawnW();
    await m.close(v.id, true);
    expect(readFileSync(join(home, 'teardown.log'), 'utf8')).toBe(`${v.id}\n`);
    expect(existsSync(v.cwd)).toBe(false);
  });
});

describe('copyIncluded', () => {
  it('copies only files that match the include list and are gitignored; symlinks stay links', async () => {
    setup();
    writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\nsecret.txt\nconfig/\n');
    g(repo, 'add', '.gitignore');
    g(repo, 'commit', '-qm', 'ignore');
    writeFileSync(join(repo, '.worktreeinclude'), '.env\nnode_modules/\nnotes.txt\nconfig/local.json\nREADME\n');
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(repo, 'config'));
    for (const f of ['.env', 'notes.txt', 'secret.txt', 'node_modules/pkg/index.js', 'config/local.json', 'config/other.json']) writeFileSync(join(repo, f), f);
    symlinkSync('pkg', join(repo, 'node_modules', 'link'));
    const dest = mkdtempSync(join(home, 'dest-'));
    expect((await wt.copyIncluded(repo, dest)).sort()).toEqual(['.env', 'config/local.json', 'node_modules/']);
    expect(readFileSync(join(dest, 'node_modules/pkg/index.js'), 'utf8')).toBe('node_modules/pkg/index.js');
    expect(lstatSync(join(dest, 'node_modules/link')).isSymbolicLink()).toBe(true);
    for (const f of ['notes.txt', 'secret.txt', 'config/other.json', 'README']) expect(existsSync(join(dest, f))).toBe(false);
    expect(await wt.copyIncluded(repo, mkdtempSync(join(home, 'dest-')), ['secret.txt'])).toEqual(['secret.txt']); // config replaces .worktreeinclude
  });
});
