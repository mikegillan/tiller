import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const versionPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function version(tag) {
  return versionPattern.exec(tag)?.slice(1).map(BigInt);
}

function compareVersions(a, b) {
  const left = version(a.tag_name);
  const right = version(b.tag_name);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? -1 : 1;
  }
  return 0;
}

export function githubApi({ repository, token, baseUrl = 'https://api.github.com', fetchImpl = fetch }) {
  if (!/^[\w][\w.-]*\/[\w][\w.-]*$/.test(repository ?? '') || !token) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  }
  return async (method, path, body) => {
    const response = await fetchImpl(`${baseUrl}/repos/${repository}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return response.json();
  };
}

// Reads actual tag objects, never the release's potentially moving target_commitish.
async function tagCommit(api, tag, knownRef) {
  const ref = knownRef ?? await api('GET', `/git/ref/tags/${encodeURIComponent(tag)}`);
  if (!ref) return null;
  let object = ref.object;
  for (let depth = 0; object.type === 'tag' && depth < 10; depth++) {
    object = (await api('GET', `/git/tags/${object.sha}`))?.object ?? {};
  }
  if (object.type !== 'commit' || !/^[0-9a-f]{40}$/.test(object.sha)) {
    throw new Error(`Tag ${tag} does not resolve to a commit`);
  }
  return object.sha;
}

export async function publishRelease({ sha, api, branch = 'main', git = args => execFileSync('git', args, { encoding: 'utf8' }).trim() }) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('RELEASE_SHA must be a full commit SHA');
  if (git(['rev-parse', 'HEAD']) !== sha) throw new Error('Checkout is not the validated SHA');

  // A PR merged into the released branch and labelled no-release publishes nothing; the next release's notes still
  // span its commits. A labelled PR into another branch that later reaches this one does not count.
  const pulls = await api('GET', `/commits/${sha}/pulls`);
  if (!Array.isArray(pulls)) throw new Error('Cannot list pull requests for the validated SHA');
  const optOut = pulls.find(pr => pr?.merged_at && pr.base?.ref === branch && pr.labels?.some(label => label?.name === 'no-release'));
  if (optOut) return { skipped: `#${optOut.number} is labelled no-release` };

  const releases = [];
  for (let page = 1; ; page++) {
    const batch = await api('GET', `/releases?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('Cannot list releases');
    for (const release of batch) {
      const hasPublicationTime = typeof release?.published_at === 'string' && Number.isFinite(Date.parse(release.published_at));
      const unpublishedDraft = release?.draft === true && release.published_at === null;
      if (!release || typeof release.tag_name !== 'string' || !release.tag_name ||
          typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean' ||
          (!hasPublicationTime && !unpublishedDraft)) {
        throw new Error('Malformed GitHub release metadata; refusing to allocate a version');
      }
    }
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  const stable = releases.filter(r => !r.draft && !r.prerelease && version(r.tag_name)).sort(compareVersions);
  // One ref listing keeps ordinary lightweight release histories within API limits.
  const refs = await api('GET', '/git/matching-refs/tags/v');
  if (!Array.isArray(refs)) throw new Error('Cannot list release tags');
  const tags = new Map(refs.map(ref => [ref.ref.slice('refs/tags/'.length), ref]));
  const commits = new Map();
  for (const release of stable) {
    const commit = await tagCommit(api, release.tag_name, tags.get(release.tag_name));
    if (!commit) throw new Error(`Published release ${release.tag_name} has no tag`);
    commits.set(release.tag_name, commit);
    if (commit === sha) return { tag: release.tag_name, alreadyPublished: true };
  }

  const previous = stable[0];
  const previousSha = previous && commits.get(previous.tag_name);
  if (previousSha) {
    // Out-of-order runs and force pushes must never publish an older source as latest.
    try {
      git(['merge-base', '--is-ancestor', previousSha, sha]);
    } catch {
      throw new Error(`Validated SHA is older than or diverges from ${previous.tag_name}; refusing release`);
    }
  }
  const [major, minor, patch] = previous ? version(previous.tag_name) : [0n, 1n, -1n];
  const tag = `v${major}.${minor}.${patch + 1n}`;
  if (releases.some(r => r.tag_name === tag)) throw new Error(`Release ${tag} already exists but is not published stable`);

  const existing = await tagCommit(api, tag);
  if (existing && existing !== sha) throw new Error(`Tag ${tag} conflicts with validated SHA; never moving it`);

  const generated = await api('POST', '/releases/generate-notes', {
    tag_name: tag,
    target_commitish: sha,
    ...(previous ? { previous_tag_name: previous.tag_name } : {}),
  });
  if (typeof generated?.body !== 'string') throw new Error('GitHub did not return release notes');
  const log = git(['log', '--reverse', '--format=- %H %s', previousSha ? `${previousSha}..${sha}` : sha]);
  const prefix = generated.body.trim();
  const compareOnly = /^(?:\*\*Full Changelog\*\*: https:\/\/github\.com\/[^\s]+\/compare\/[^\s]+)?$/.test(prefix);
  const subjects = compareOnly ? git(['log', '--reverse', '--no-merges', '--format=%s', previousSha ? `${previousSha}..${sha}` : sha]) : '';
  const changes = subjects.split('\n').filter(Boolean)
    .map(subject => `- ${subject.replace(/([\\`*{}_\[\]()<>#+.!|~-])/g, '\\$1')}`).join('\n');
  const primary = compareOnly ? [changes || 'No change descriptions provided.', prefix].filter(Boolean).join('\n\n') : prefix;
  const body = `${primary}\n\n<details>\n<summary>Technical details</summary>\n\n<!-- tiller-release-evidence:v1 -->\n\n## Commits\n\n${log}\n\nValidated source: ${sha}\n</details>\n`;
  if (Buffer.byteLength(body) > 125_000) throw new Error('Release notes too large; prepare a reviewed baseline release');

  if (!existing) await api('POST', '/git/refs', { ref: `refs/tags/${tag}`, sha });
  if (await tagCommit(api, tag) !== sha) throw new Error(`Tag ${tag} changed during publication`);
  await api('POST', '/releases', {
    tag_name: tag,
    target_commitish: sha,
    name: tag,
    body,
    draft: false,
    prerelease: false,
    make_latest: 'true',
  });
  return { tag, alreadyPublished: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // Only push main is authorized by this workflow. Reruns retain the event SHA.
    if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/main') {
      throw new Error('Releases require a push to main');
    }
    const result = await publishRelease({
      sha: process.env.RELEASE_SHA,
      branch: process.env.GITHUB_REF_NAME,
      api: githubApi({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN, baseUrl: process.env.GITHUB_API_URL }),
    });
    console.log(result.skipped ? `no release: ${result.skipped}` : `${result.tag}: ${result.alreadyPublished ? 'already published' : 'published'}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
