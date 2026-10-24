import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { githubApi, publishRelease } from './release.mjs';

// Real git history verifies roll-up boundaries and ancestry independently of API mocks.
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'tiller-release-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'Release Test']);
  git(['config', 'user.email', 'release@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  const commit = subject => {
    writeFileSync(join(cwd, 'source'), subject);
    git(['add', 'source']);
    git(['commit', '-qm', subject]);
    return git(['rev-parse', 'HEAD']);
  };
  const first = commit('Initial implementation');
  const second = commit('Fix direct commit');
  const third = commit('Merge pull request #7: useful change');
  const releases = [];
  const tags = new Map();
  const calls = [];
  const pulls = new Map();
  let failPublication = false;
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path.startsWith('/commits/')) {
      const pr = pulls.get(path.split('/')[2]);
      if (pr instanceof Error) throw pr;
      return pr ? [pr] : [];
    }
    if (path.startsWith('/releases?')) {
      const page = Number(new URLSearchParams(path.split('?')[1]).get('page'));
      return releases.slice((page - 1) * 100, page * 100);
    }
    if (path === '/git/matching-refs/tags/v') return [...tags].map(([tag, value]) => ({ ref: `refs/tags/${tag}`, ...value }));
    if (path.startsWith('/git/ref/tags/')) return tags.get(decodeURIComponent(path.slice('/git/ref/tags/'.length))) ?? null;
    if (path === '/git/tags/annotated') return { object: { type: 'commit', sha: first } };
    if (path === '/releases/generate-notes') return { body: "## What's Changed\n* Useful change by @example in #7" };
    if (method === 'POST' && path === '/git/refs') {
      assert(!tags.has(body.ref.slice('refs/tags/'.length)), 'never overwrite a tag');
      tags.set(body.ref.slice('refs/tags/'.length), { object: { type: 'commit', sha: body.sha } });
      return {};
    }
    if (method === 'POST' && path === '/releases') {
      if (failPublication) throw new Error('Publication failed');
      const release = { ...body, published_at: '2026-10-17T00:00:00Z' };
      releases.push(release);
      return release;
    }
    throw new Error(`Unexpected ${method} ${path}`);
  };
  const addRelease = (tag, sha, extra = {}) => {
    releases.push({ tag_name: tag, draft: false, prerelease: false, published_at: '2026-10-17T00:00:00Z', ...extra });
    tags.set(tag, { object: { type: 'commit', sha } });
  };
  return { first, second, third, git, api, releases, tags, calls, pulls, addRelease, fail: value => { failPublication = value; } };
}

const merged = (number, ...labels) => ({ number, merged_at: '2026-10-17T00:00:00Z', labels: labels.map(name => ({ name })) });

test('a merged PR labelled no-release publishes nothing; the next release rolls up its commits', async t => {
  const f = fixture(t);
  f.addRelease('v0.1.0', f.first);
  f.pulls.set(f.second, merged(6, 'tests', 'no-release'));
  f.git(['checkout', '--detach', f.second]);
  assert.deepEqual(await publishRelease({ sha: f.second, api: f.api, git: f.git }), { skipped: '#6 is labelled no-release' });
  assert(!f.calls.some(c => c.method === 'POST'));
  assert.equal(f.tags.size, 1);
  f.pulls.set(f.third, merged(7, 'tests'));
  f.git(['checkout', '--detach', f.third]);
  assert.equal((await publishRelease({ sha: f.third, api: f.api, git: f.git })).tag, 'v0.1.1');
  const body = f.releases.at(-1).body;
  assert(body.includes(f.second));
  assert(body.includes(f.third));
});

test('fails closed, publishing nothing, when the PR lookup fails', async t => {
  const f = fixture(t);
  f.pulls.set(f.third, new Error('GitHub GET /commits/x/pulls: HTTP 403'));
  await assert.rejects(publishRelease({ sha: f.third, api: f.api, git: f.git }), /HTTP 403/);
  const missing = fixture(t);
  await assert.rejects(publishRelease({ sha: missing.third, api: async () => null, git: missing.git }), /Cannot list pull requests/);
  assert(!f.calls.some(c => c.method === 'POST'));
});

test('first release is stable v0.1.0 at exact validated SHA, includes PR and all commit notes', async t => {
  const f = fixture(t);
  assert.deepEqual(await publishRelease({ sha: f.third, api: f.api, git: f.git }), { tag: 'v0.1.0', alreadyPublished: false });
  const release = f.releases[0];
  assert.equal(release.target_commitish, f.third);
  assert.equal(f.tags.get('v0.1.0').object.sha, f.third);
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, false);
  assert.equal(release.make_latest, 'true');
  const primary = release.body.split('<details>')[0];
  assert.match(primary, /Useful change by @example in #7/);
  assert(!primary.includes(f.first));
  assert(!primary.includes('Initial implementation'));
  for (const sha of [f.first, f.second, f.third]) assert(release.body.includes(sha));
  assert.equal(f.calls.find(c => c.path === '/releases/generate-notes').body.previous_tag_name, undefined);
});

test('increments numeric highest stable PATCH and rolls up only since that release', async t => {
  const f = fixture(t);
  f.addRelease('v0.1.9', f.first);
  f.addRelease('v0.1.10', f.second);
  f.addRelease('v99.0.0', f.third, { prerelease: true });
  f.addRelease('v88.0.0', f.third, { draft: true });
  f.addRelease('nightly', f.third);
  const result = await publishRelease({ sha: f.third, api: f.api, git: f.git });
  assert.equal(result.tag, 'v0.1.11');
  const generated = f.calls.find(c => c.path === '/releases/generate-notes').body;
  assert.equal(generated.previous_tag_name, 'v0.1.10');
  assert.equal(generated.target_commitish, f.third);
  const body = f.releases.at(-1).body;
  assert(!body.includes(f.first));
  assert(!body.includes(f.second));
  assert(body.includes('Merge pull request #7'));
});

test('release rerun is a no-op even after later publication, with annotated tags', async t => {
  const f = fixture(t);
  f.addRelease('v0.1.0', f.first);
  f.tags.set('v0.1.0', { object: { type: 'tag', sha: 'annotated' } });
  f.addRelease('v0.1.1', f.third);
  f.git(['checkout', '--detach', f.first]);
  assert.deepEqual(await publishRelease({ sha: f.first, api: f.api, git: f.git }), { tag: 'v0.1.0', alreadyPublished: true });
  assert(!f.calls.some(c => c.method === 'POST'));
});

test('failed publication leaves exact tag; retry reuses it without bumping', async t => {
  const f = fixture(t);
  f.fail(true);
  await assert.rejects(publishRelease({ sha: f.third, api: f.api, git: f.git }), /Publication failed/);
  assert.equal(f.releases.length, 0);
  assert.equal(f.tags.get('v0.1.0').object.sha, f.third);
  f.fail(false);
  await publishRelease({ sha: f.third, api: f.api, git: f.git });
  assert.equal(f.releases[0].tag_name, 'v0.1.0');
  assert.equal(f.calls.filter(c => c.path === '/git/refs').length, 1);
  const writes = f.calls.filter(c => c.method === 'POST').length;
  await publishRelease({ sha: f.third, api: f.api, git: f.git });
  assert.equal(f.calls.filter(c => c.method === 'POST').length, writes);
});

test('lost publication response is recovered by discovering the published release', async t => {
  const f = fixture(t);
  const losingResponse = async (method, path, body) => {
    const result = await f.api(method, path, body);
    if (method === 'POST' && path === '/releases') throw new Error('Connection lost');
    return result;
  };
  await assert.rejects(publishRelease({ sha: f.third, api: losingResponse, git: f.git }), /Connection lost/);
  assert.deepEqual(await publishRelease({ sha: f.third, api: f.api, git: f.git }), { tag: 'v0.1.0', alreadyPublished: true });
  assert.equal(f.calls.filter(c => c.method === 'POST' && c.path === '/releases').length, 1);
});

test('conflicting tag or draft blocks publication without overwriting anything', async t => {
  for (const draft of [false, true]) {
    const f = fixture(t);
    if (draft) f.addRelease('v0.1.0', f.third, { draft: true });
    else f.tags.set('v0.1.0', { object: { type: 'commit', sha: f.first } });
    await assert.rejects(publishRelease({ sha: f.third, api: f.api, git: f.git }), /conflicts|already exists/);
    assert(!f.calls.some(c => c.method === 'POST'));
  }
});

test('wrong checkout, stale SHA, missing published tag and invalid SHA fail closed', async t => {
  const f = fixture(t);
  await assert.rejects(publishRelease({ sha: 'main', api: f.api, git: f.git }), /full commit SHA/);
  await assert.rejects(publishRelease({ sha: f.first, api: f.api, git: f.git }), /Checkout/);
  f.addRelease('v0.1.0', f.third);
  f.git(['checkout', '--detach', f.second]);
  await assert.rejects(publishRelease({ sha: f.second, api: f.api, git: f.git }), /older than or diverges/);
  f.tags.delete('v0.1.0');
  await assert.rejects(publishRelease({ sha: f.second, api: f.api, git: f.git }), /has no tag/);
  assert(!f.calls.some(c => c.method === 'POST'));
});

test('release discovery paginates; non-semver releases do not establish a baseline', async t => {
  const f = fixture(t);
  for (let i = 0; i < 100; i++) f.addRelease(`nightly-${i}`, f.first);
  f.addRelease('v2.3.4', f.first);
  assert.equal((await publishRelease({ sha: f.third, api: f.api, git: f.git })).tag, 'v2.3.5');
  assert(f.calls.some(c => c.path.endsWith('page=2')));
  assert.equal(f.calls.filter(c => c.path === '/git/matching-refs/tags/v').length, 1);
});

test('malformed release metadata cannot reset the published version baseline', async t => {
  const f = fixture(t);
  f.addRelease('v2.0.0', f.first);
  const valid = f.releases[0];
  for (const malformed of [
    { ...valid, published_at: undefined },
    { ...valid, published_at: null },
    { ...valid, published_at: 'invalid' },
    { ...valid, draft: undefined },
    { ...valid, prerelease: undefined },
    { ...valid, tag_name: undefined },
    null,
    'v2.0.0',
  ]) {
    f.releases.splice(0, f.releases.length, malformed);
    await assert.rejects(publishRelease({ sha: f.third, api: f.api, git: f.git }), /Malformed GitHub release metadata/);
    assert(!f.calls.some(c => c.method === 'POST'), 'malformed metadata must never publish v0.1.0');
    assert(!f.tags.has('v0.1.0'));
  }
  f.releases.splice(0, f.releases.length, valid);
  assert.equal((await publishRelease({ sha: f.third, api: f.api, git: f.git })).tag, 'v2.0.1');
});

test('force-pushed divergent source cannot replace the latest stable source', async t => {
  const f = fixture(t);
  f.addRelease('v0.1.0', f.third);
  f.git(['checkout', '--detach', f.first]);
  f.git(['commit', '--allow-empty', '-qm', 'Divergent main']);
  const divergent = f.git(['rev-parse', 'HEAD']);
  await assert.rejects(publishRelease({ sha: divergent, api: f.api, git: f.git }), /diverges/);
  assert(!f.calls.some(c => c.method === 'POST'));
});

test('notes failure prevents even tag creation; changed tag blocks release creation', async t => {
  const f = fixture(t);
  const failing = async (method, path, body) => {
    if (path === '/releases/generate-notes') throw new Error('Notes unavailable');
    return f.api(method, path, body);
  };
  await assert.rejects(publishRelease({ sha: f.third, api: failing, git: f.git }), /Notes unavailable/);
  assert.equal(f.tags.size, 0);
  const racing = async (method, path, body) => {
    const result = await f.api(method, path, body);
    if (path === '/git/refs') f.tags.set('v0.1.0', { object: { type: 'commit', sha: f.first } });
    return result;
  };
  await assert.rejects(publishRelease({ sha: f.third, api: racing, git: f.git }), /changed during publication/);
  assert.equal(f.releases.length, 0);
});

test('API authenticates, bounds requests, treats only GET 404 as absent and rejects failures', async () => {
  let response = { status: 404, ok: false };
  let request;
  const api = githubApi({ repository: 'owner/repo', token: 'test-token', fetchImpl: async (...args) => { request = args; return response; } });
  assert.equal(await api('GET', '/git/ref/tags/v0.1.0'), null);
  assert.equal(request[0], 'https://api.github.com/repos/owner/repo/git/ref/tags/v0.1.0');
  assert.equal(request[1].headers.Authorization, 'Bearer test-token');
  assert(request[1].signal instanceof AbortSignal);
  for (const status of [403, 422, 500]) {
    response = { status, ok: false };
    await assert.rejects(api('POST', '/releases', { tag_name: 'v0.1.0' }), new RegExp(`HTTP ${status}`));
  }
  response = { status: 404, ok: false };
  await assert.rejects(api('POST', '/releases', {}), /HTTP 404/);
  assert.throws(() => githubApi({ repository: '../elsewhere', token: 'token' }), /required/);
});

test('direct-commit releases show actual non-merge subjects with full evidence collapsed', async t => {
  const f = fixture(t);
  const generated = '**Full Changelog**: https://github.com/example/tiller/compare/v0.1.0...v0.1.1';
  const api = (method, path, body) => path === '/releases/generate-notes' ? { body: generated } : f.api(method, path, body);
  await publishRelease({ sha: f.third, api, git: f.git });
  const [primary, details] = f.releases[0].body.split('<details>');
  assert.match(primary, /- Initial implementation\n- Fix direct commit/);
  assert(primary.includes(generated));
  assert(!primary.includes(f.first));
  // The fixture's merge-looking subject is a direct commit, so --no-merges
  // correctly keeps it. A real merge is checked separately below.
  assert(details.includes('<!-- tiller-release-evidence:v1 -->'));
  for (const sha of [f.first, f.second, f.third]) assert(details.includes(sha));
  assert(details.includes(`Validated source: ${f.third}`));
});

test('empty GitHub summary falls back to subjects, excluding actual merge commits only from the primary view', async t => {
  const f = fixture(t);
  f.git(['checkout', '-b', 'feature', f.first]);
  f.git(['commit', '--allow-empty', '-qm', 'Fix [links] and *emphasis*']);
  const feature = f.git(['rev-parse', 'HEAD']);
  f.git(['checkout', '--detach', f.third]);
  f.git(['merge', '--no-ff', '-m', 'Merge branch feature', feature]);
  const sha = f.git(['rev-parse', 'HEAD']);
  const api = (method, path, body) => path === '/releases/generate-notes' ? { body: '' } : f.api(method, path, body);
  await publishRelease({ sha, api, git: f.git });
  const [primary, details] = f.releases[0].body.split('<details>');
  assert(primary.includes('- Fix \\[links\\] and \\*emphasis\\*'));
  assert(!primary.includes('Merge branch feature'));
  assert(details.includes(`- ${sha} Merge branch feature`));
  assert(details.includes(feature));
});
