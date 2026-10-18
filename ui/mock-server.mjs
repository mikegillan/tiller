// Fake daemon for developing the UI without the real one. Token: "mock".
//   node ui/mock-server.mjs            ws on :7789; also serves ui/dist at http://127.0.0.1:7789/?k=mock when it has been built
// Mutations (spawn, close, restart, rename, resume, prune, select, merge, mute, dnd) work in memory; a confirm request arrives
// 15 s after connecting. diff on a worktree node returns a made-up diff; send logs the text and replies queued.
// history, transcript, followup and spawn with fork answer from the fake archive below; tl-d and the archived "auth refactor" have two sessions.
// spawn with isolation "worktree" fakes a worktree; a plain close of a worktree node whose title contains "dirty" is refused, as the daemon would.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.TL_MOCK_PORT ?? 7789);
const DIST = fileURLToPath(new URL('./dist', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

// Optional update preview: TL_MOCK_UPDATE=available|blocked|checking|applying|current|restart|failed|no-target.
// All updater actions stay in memory; no checkout, build or process is touched.
const updateScenario = process.env.TL_MOCK_UPDATE;
const release = { id: 13, tag: 'v0.1.13', name: 'v0.1.13', sha: 'abcdef1234567890', tagObject: 'release-tag', publishedAt: '2026-10-18T12:00:00Z', body: '## Improvements\n\n- Clearer explanations when a checkout blocks updates.\n- Updated setup and development documentation.\n\n## Commits\n\n- 1234567890123456789012345678901234567890 Clarify update blockers\n\nValidated source: 1234567890123456789012345678901234567890\n' };
let updateStatus = updateScenario ? {
  sha: '970da3e1234567890', runtimeSha: '970da3e1234567890', currentVersion: 'v0.1.12', checkedAt: Date.now(), eligible: true, target: release, releases: [release],
  ...(updateScenario === 'blocked' ? { eligible: false, blocker: 'dirty', reason: 'The main checkout has uncommitted or untracked files.' } : {}),
  ...(updateScenario === 'checking' ? { checking: true } : {}),
  ...(updateScenario === 'applying' ? { applying: true } : {}),
  ...(updateScenario === 'failed' ? { eligible: false, fetchError: 'Release check unavailable: the network is offline.', reason: 'Check again when the connection is restored.' } : {}),
  ...(['current', 'restart'].includes(updateScenario) ? { sha: release.sha, currentVersion: release.tag, ...(updateScenario === 'current' ? { runtimeSha: release.sha } : {}) } : {}),
  ...(updateScenario === 'no-target' ? { eligible: false, target: undefined, releases: [], reason: 'No published stable releases.' } : {}),
} : undefined;

const now = Date.now();
const MIN = 60_000;
const nodes = new Map();
let dnd = { on: false };
// A node's spend is its session cost, all of it today.
const add = (id, parentId, title, cwd, kind, { ago = 0, ...st } = {}, extra = {}) =>
  nodes.set(id, {
    id, parentId, title, cwd, kind, createdAt: now - 3 * 3600_000, unread: false, ...extra,
    ...(st.costUsd !== undefined && { spentUsd: st.costUsd, spentToday: { day: new Date(now).toLocaleDateString('en-CA'), usd: st.costUsd } }),
    status: { state: kind === 'terminal' ? 'none' : 'working', changedAt: now - ago, ...st },
  });
const OPUS = { model: 'claude-opus-5-5', effort: 'high' };
const SONNET = { model: 'claude-sonnet-5-5', effort: 'medium' };
const HAIKU = { model: 'claude-haiku-4-5', effort: 'low' };

// Session 1: this repo.
add('tl', null, 'tiller', '/Users/scott/workspace/tiller', 'claude', { ...OPUS, ago: 20_000, activity: 'Task: polish the UI', contextPct: 42, contextTokens: 84_000, contextWindow: 200_000, costUsd: 3.42, lastAssistantMessage: 'I split the work into three children: ui polish, tests, and daemon. Waiting on tests to finish its dependency reinstall.' });
add('tl-ui', 'tl', 'ui polish', '/Users/scott/workspace/tiller/ui', 'claude', { ...SONNET, ago: 4_000, activity: 'Edit: ui/NodeRow.tsx', contextPct: 71, contextTokens: 142_000, contextWindow: 200_000, costUsd: 1.18 }, { unread: true });
add('tl-css', 'tl-ui', 'css review', '/Users/scott/workspace/tiller/ui', 'claude', { ...HAIKU, state: 'done', ago: 12 * MIN, contextPct: 18, contextTokens: 36_000, contextWindow: 200_000, costUsd: 0.07, lastAssistantMessage: 'Reviewed theme.css and sidebar.css.\n\nFindings:\n- The connector lines use border colours from --line, good in both themes.\n- .actions overlaps the age on narrow widths; consider hiding the age at hover (already done).\n- No hard-coded colours outside theme.css except the toast shadow.' });
add('tl-sh', 'tl-ui', 'shell', '/Users/scott/workspace/tiller/ui', 'terminal', { ago: 40 * MIN });
add('tl-test', 'tl', 'tests', '/Users/scott/workspace/tiller', 'claude', { ...SONNET, state: 'blocked', ago: 90_000, activity: 'needs approval: Bash: rm -rf node_modules && npm ci && npm test -- --run ui', contextPct: 23, contextTokens: 46_000, contextWindow: 200_000, costUsd: 0.31 }, { unread: true });
add('tl-d', 'tl', 'daemon', '/Users/scott/workspace/tiller', 'claude', { ...OPUS, state: 'done', ago: 25 * MIN, contextPct: 86, contextTokens: 172_000, contextWindow: 200_000, costUsd: 6.9, lastAssistantMessage: 'The daemon now serves ui/dist and reports /health. All 214 tests pass.' });
add('tl-wt', 'tl', 'worktree gone', '/Users/scott/workspace/tiller/.claude/worktrees/tl-wt', 'claude', { ...SONNET, state: 'done', exited: true, ago: 50 * MIN }, { worktree: { repo: '/Users/scott/workspace/tiller', path: '/Users/scott/workspace/tiller/.claude/worktrees/tl-wt', branch: 'tl/tl-wt', base: 'main', baseSha: '6977f01', missing: true } });
add('tl-feat', 'tl', 'diff view', '/Users/scott/workspace/tiller/.claude/worktrees/tl-feat', 'claude', { ...SONNET, state: 'done', ago: 6 * MIN, contextPct: 37, contextTokens: 74_000, contextWindow: 200_000, costUsd: 0.88, lastAssistantMessage: 'Added the diff tab and its tests.', git: { branch: 'tl/tl-feat', base: 'main', ahead: 2, behind: 0, dirty: 1, additions: 14, deletions: 4 } }, { worktree: { repo: '/Users/scott/workspace/tiller', path: '/Users/scott/workspace/tiller/.claude/worktrees/tl-feat', branch: 'tl/tl-feat', base: 'main', baseSha: '6977f01' } });
add('tl-spike', 'tl', 'spike: tauri', '/Users/scott/workspace/tiller', 'claude', { ...SONNET, state: 'done', exited: true, ago: 5 * 3600_000, contextPct: 55, contextTokens: 110_000, contextWindow: 200_000, costUsd: 2.05, lastAssistantMessage: 'Tauri wraps the same ui/dist; WKWebView needs the DOM renderer.' });

// Session 2: another project.
add('dc', null, 'dotcms-core', '/Users/scott/code/dotcms-core', 'claude', { ...SONNET, ago: 2 * MIN, activity: 'Bash: ./mvnw -pl dotCMS test', contextPct: 88, contextTokens: 176_000, contextWindow: 200_000, costUsd: 4.4 });
add('dc-mig', 'dc', 'migration', '/Users/scott/code/dotcms-core', 'claude', { ...OPUS, state: 'done', errored: true, ago: 8 * MIN, contextPct: 61, contextTokens: 122_000, contextWindow: 200_000, costUsd: 2.6, lastAssistantMessage: 'StopFailure: the turn ended with an API error (overloaded). Retry or resume.' });
add('dc-b', 'dc', 'build', '/Users/scott/code/dotcms-core', 'terminal', { ago: 3 * MIN });

// Session 3: scratch work, idle.
add('sc', null, 'scratch', '/tmp/scratch', 'claude', { ...HAIKU, state: 'done', ago: 3 * 3600_000, contextPct: 9, contextTokens: 18_000, contextWindow: 200_000, costUsd: 0.02, lastAssistantMessage: 'Done: wrote /tmp/scratch/out.csv with 120 rows.' });

const SCREENS = {
  claude: (n) => `\x1b[1;36m● ${n.title}\x1b[0m  \x1b[2m${n.cwd}\x1b[0m\r\n\r\n\x1b[2m> \x1b[0mplease keep going\r\n\r\n\x1b[32m✓\x1b[0m Read ui/store.ts\r\n\x1b[32m✓\x1b[0m Edit ui/NodeRow.tsx \x1b[2m(+24 -6)\x1b[0m\r\n\x1b[33m●\x1b[0m ${n.status.activity ?? 'Thinking…'}\r\n\r\n\x1b[2m╭────────────────────────────────────────────╮\r\n│\x1b[0m > \x1b[7m \x1b[0m                                         \x1b[2m│\r\n╰────────────────────────────────────────────╯\x1b[0m\r\n`,
  terminal: (n) => `\x1b[32m${n.cwd.split('/').pop()}\x1b[0m \x1b[34m$\x1b[0m `,
};

// What the daemon's diff might say for tl-feat (counts match its git state above); any worktree node gets the same.
const FAKE_DIFF = [
  { path: 'ui/DiffPane.tsx', status: 'added', additions: 6, deletions: 0, patch: [
    'diff --git a/ui/DiffPane.tsx b/ui/DiffPane.tsx', 'new file mode 100644', '--- /dev/null', '+++ b/ui/DiffPane.tsx', '@@ -0,0 +1,6 @@',
    "+import { useState } from 'react';", '+', '+export function DiffPane() {', '+  const [path, setPath] = useState<string>();', '+  return <div className="diffpane">{path}</div>;', '+}', ''].join('\n') },
  { path: 'ui/store.ts', status: 'modified', additions: 8, deletions: 3, patch: [
    'diff --git a/ui/store.ts b/ui/store.ts', '--- a/ui/store.ts', '+++ b/ui/store.ts', '@@ -40,6 +40,8 @@ export interface State {',
    '   /** Account-level rate limits. */', '   usage?: Usage;', '-  panel: boolean;', '+  panel: boolean;', '+  /** The Diff tab is showing. */', '+  diffOpen: boolean;', ' }', ' ', ' const stored = 1;',
    '@@ -120,5 +122,8 @@ export function applyServer(m: ServerMessage) {', "     case 'confirmDone':", '       return dropConfirm(m.confirmId);',
    "-    case 'error':", "-      return toast(m.message, m.id, 'bad');", "+    case 'diff':", '+      return update(() => ({ diff: m }));', "+    case 'error':", "+      return toast(m.message, m.id, 'bad');", '+    // sent: below', '   }', ''].join('\n') },
  { path: 'ui/old-panel.css', status: 'deleted', additions: 0, deletions: 1, patch: [
    'diff --git a/ui/old-panel.css b/ui/old-panel.css', 'deleted file mode 100644', '--- a/ui/old-panel.css', '+++ /dev/null', '@@ -1 +0,0 @@', '-.panel { width: 300px; }', ''].join('\n') },
  { path: 'ui/icon.png', status: 'added', additions: 0, deletions: 0, binary: true },
];

// Closed nodes, newest first, as the daemon's archive.jsonl would hold them.
const archive = [
  { id: 'a-css', rootId: 'tl', parentId: 'tl-ui', title: 'css tokens', cwd: '/Users/scott/workspace/tiller/ui', ...HAIKU, role: 'worker', sessionId: '3b1f9c20-aa11-4c55-9d0e-1f2e3d4c5b6a',
    prompt: 'Move every hard-coded colour in ui/*.css into theme.css variables.', brief: 'Moved 14 colours into theme.css variables; light theme checked. Succeeded.',
    lastAssistantMessage: 'All colours now come from theme.css.', outcome: { outcome: 'succeeded', summary: 'Moved 14 colours into theme.css variables.', changedFiles: ['ui/theme.css', 'ui/layout.css'], at: now - 30 * MIN },
    spentUsd: 0.12, createdAt: now - 2 * 3600_000, closedAt: now - 30 * MIN },
  { id: 'a-auth', rootId: 'tl', parentId: 'tl', title: 'auth refactor', cwd: '/Users/scott/workspace/tiller/.claude/worktrees/a-auth', ...OPUS, role: 'worker',
    sessionId: '9f8e7d6c-1111-2222-3333-444455556666', previousSessions: ['5a4b3c2d-7777-8888-9999-000011112222'], branch: 'tl/a-auth', branchFate: 'kept',
    prompt: 'Replace the token check in the WebSocket handshake with a constant-time compare and add tests.', brief: 'Token check is constant-time with tests; merge failed on a conflict in server.ts. Failed.',
    lastAssistantMessage: 'The merge stopped on a conflict in src/daemon/server.ts.', outcome: { outcome: 'failed', summary: 'Merge conflict in src/daemon/server.ts.', openQuestions: ['Rebase on main or merge by hand?'], at: now - 3 * 3600_000 },
    spentUsd: 2.41, createdAt: now - 26 * 3600_000, closedAt: now - 3 * 3600_000 },
  { id: 'a-probe', rootId: 'tl', parentId: 'tl', title: 'probe: xterm webgl', cwd: '/Users/scott/workspace/tiller', ...SONNET, sessionId: 'c0ffee00-1234-5678-9abc-def012345678',
    branch: 'tl/a-probe', branchFate: 'discarded',
    prompt: 'Does the WebGL renderer work in WKWebView?', lastAssistantMessage: 'No: WKWebView loses the WebGL context on sleep; the DOM renderer is the safe choice.',
    spentUsd: 0.64, createdAt: now - 3 * 86400_000, closedAt: now - 2 * 86400_000 },
  { id: 'a-mig', rootId: 'dc', parentId: 'dc', title: 'db migration dry run', cwd: '/Users/scott/code/dotcms-core', ...OPUS, sessionId: 'deadbeef-0000-1111-2222-333344445555', branch: 'tl/a-mig', branchFate: 'merged', base: 'main',
    prompt: 'Dry-run the 24.10 schema migration against the staging dump.', brief: 'Dry run passed on the staging dump in 4 minutes; two slow indexes noted. Succeeded.',
    outcome: { outcome: 'succeeded', summary: 'Dry run passed.', at: now - 5 * 3600_000 }, spentUsd: 1.9, createdAt: now - 7 * 3600_000, closedAt: now - 5 * 3600_000 },
];

const LONG = Array.from({ length: 14 }, (_, i) => `${i + 1}. ${['Read the handshake code', 'Wrote the failing test', 'Switched to timingSafeEqual', 'Ran the suite'][i % 4]}: details of step ${i + 1}, which go on long enough to wrap at the pane's width.`).join('\n');
// A transcript for any Claude node: the current session, or an older one when asked for by id.
function transcriptFor(id, sessionId) {
  const live = nodes.get(id), arch = archive.find((a) => a.id === id);
  if (live?.kind === 'terminal') return { error: `${id} is a terminal; only Claude nodes have a transcript` };
  if (!live && !arch) return { error: `no live or archived node ${id}` };
  const ids = arch ? [arch.sessionId, ...(arch.previousSessions ?? [])] : live.sessionId ? [live.sessionId, ...(live.previousSessions ?? [])] : id === 'tl-d' ? ['11112222-aaaa', '33334444-bbbb'] : [`${id}-session`];
  if (sessionId && !ids.includes(sessionId)) return { error: `no session ${sessionId} on record for ${id}` };
  const sessions = ids.map((s, i) => ({ sessionId: s, current: i === 0, ...(live?.harness ? { harness: i === 0 ? live.harness : live.sessionHistory?.find((old) => old.sessionId === s)?.harness ?? 'claude' } : {}) }));
  const t0 = (arch?.closedAt ?? now) - 40 * MIN, title = arch?.title ?? live.title;
  if (sessionId && sessionId !== ids[0]) return { sessions, entries: [
    { role: 'user', at: t0 - 86400_000, text: `Earlier session of ${title}: start on the handshake.` },
    { role: 'assistant', at: t0 - 86400_000 + 2 * MIN, text: 'Read the handshake; the token is compared with ===.', tools: ['Read', 'Grep'] },
  ] };
  return { sessions, truncated: id === 'a-auth', entries: [
    { role: 'user', at: t0, text: arch?.prompt ?? `Work on ${title}.` },
    { role: 'assistant', at: t0 + MIN, text: 'I will look at the current code first.', tools: ['Read', 'Read', 'Grep', 'Bash'] },
    { role: 'assistant', at: t0 + 6 * MIN, text: `Here is the plan, step by step:\n${LONG}`, tools: ['Edit', 'Edit', 'Bash'] },
    { role: 'user', text: '--- TL MESSAGE ---\nfrom: tiller\nPlease also cover the reconnect path.\n--- END TL MESSAGE ---' },
    { role: 'assistant', at: t0 + 20 * MIN, text: '', tools: ['mcp__tiller__report_outcome'] },
    { role: 'assistant', at: t0 + 21 * MIN, text: arch?.lastAssistantMessage ?? live?.status.lastAssistantMessage ?? 'Done for now.' },
  ] };
}

const clients = new Set();
const broadcast = (m) => clients.forEach((c) => c.ws.send(JSON.stringify(m)));
const touch = (n, patch) => { Object.assign(n.status, patch, { changedAt: Date.now() }); broadcast({ t: 'node', node: n }); };

// Light life: the working node's context creeps up.
setInterval(() => {
  const n = nodes.get('tl-ui');
  if (n && !n.status.exited && n.status.contextPct < 95) touch(n, { contextPct: n.status.contextPct + 1, costUsd: +(n.status.costUsd + 0.02).toFixed(2) });
}, 8000);

const http = createServer(async (req, res) => {
  const path = normalize(new URL(req.url, 'http://x').pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const file = await readFile(join(DIST, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? (path === '/' ? 'text/html' : 'application/octet-stream') }).end(file);
  } catch { res.writeHead(404).end('not found (run npm run ui:build to serve the UI from here)'); }
});

const wss = new WebSocketServer({ server: http, path: '/ws' });
wss.on('connection', (ws) => {
  const client = { ws, attached: new Set() };
  const send = (m) => ws.send(JSON.stringify(m));
  let authed = false;
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (!authed) {
      if (m.t !== 'auth' || m.token !== 'mock') return ws.close();
      authed = true;
      clients.add(client);
      send({ t: 'snapshot', nodes: [...nodes.values()], dnd, ...(updateStatus ? { update: updateStatus } : {}) });
      if (!updateScenario) setTimeout(() => ws.readyState === 1 && send({ t: 'confirm', confirmId: 'c1', text: 'ui polish wants to close node "shell".\nIt has been idle for 40 minutes.' }), 15_000);
      return;
    }
    const n = nodes.get(m.id);
    switch (m.t) {
      case 'updateCheck':
        if (updateStatus && !updateStatus.applying && !updateStatus.checking) {
          updateStatus = { ...updateStatus, checking: true };
          broadcast({ t: 'update', update: updateStatus });
          setTimeout(() => {
            updateStatus = { ...updateStatus, checking: false, checkedAt: Date.now() };
            broadcast({ t: 'update', update: updateStatus });
          }, 3000);
        }
        break;
      case 'update':
        if (updateStatus?.eligible && !updateStatus.applying && !updateStatus.checking && m.tag === release.tag && m.sha === release.sha) {
          updateStatus = { ...updateStatus, applying: true };
          broadcast({ t: 'update', update: updateStatus });
        }
        break;
      case 'attach': if (n) send({ t: 'data', id: m.id, data: SCREENS[n.kind === 'terminal' ? 'terminal' : 'claude'](n) }); break;
      case 'input': send({ t: 'data', id: m.id, data: m.data === '\r' ? '\r\n$ ' : m.data }); break;
      case 'select': if (n?.unread) { n.unread = false; broadcast({ t: 'node', node: n }); } break;
      case 'rename': if (n) { n.title = m.title; broadcast({ t: 'node', node: n }); } break;
      case 'resume': if (n) touch(n, { exited: false, state: n.kind === 'terminal' ? 'none' : 'working' }); break;
      case 'restart': if (n) touch(n, { exited: false, state: n.kind === 'terminal' ? 'none' : 'unknown', activity: 'restarting', contextPct: 0, contextTokens: 0, costUsd: 0, lastAssistantMessage: undefined }); break;
      case 'changeHarness': {
        if (!n || n.kind === 'terminal' || !['claude', 'codex', 'pi'].includes(m.harness) || (n.harness ?? 'claude') === m.harness) break;
        const old = n.sessionId ?? `${n.id}-session`;
        n.sessionHistory = [...(n.sessionHistory ?? []), { sessionId: old, harness: n.harness ?? 'claude' }];
        n.previousSessions = [...(n.previousSessions ?? []), old];
        n.sessionId = `${n.id}-${Date.now()}`;
        n.kind = 'agent'; n.harness = m.harness;
        n.model = n.effort = n.permissionMode = n.preset = undefined;
        touch(n, { exited: false, state: 'unknown', activity: `starting ${m.harness}`, model: undefined, effort: undefined, contextPct: 0, contextTokens: 0, costUsd: 0, lastAssistantMessage: undefined });
        break;
      }
      case 'close': if (n?.worktree && !m.worktree && n.title.includes('dirty')) send({ t: 'error', id: m.id, message: 'worktree has 2 uncommitted files and 1 unmerged commit; close with keep or discard' });
        else if (n) { nodes.delete(m.id); broadcast({ t: 'removed', id: m.id }); } break;
      case 'prune': for (const x of [...nodes.values()]) if (x.status.exited && ![...nodes.values()].some((c) => c.parentId === x.id)) { nodes.delete(x.id); broadcast({ t: 'removed', id: x.id }); } break;
      case 'spawn': {
        if (m.fork) console.log(`spawn ${m.title} forked from ${m.fork}`);
        const id = `n${nodes.size + 1}${Date.now() % 1000}`;
        const worktree = m.isolation === 'worktree' && { repo: m.cwd, path: `${m.cwd}/.claude/worktrees/${id}`, branch: `tl/${id}`, base: 'main', baseSha: '6977f01' };
        const git = worktree && { git: { branch: worktree.branch, base: 'main', ahead: 0, behind: 0, dirty: 0, additions: 0, deletions: 0 } };
        add(id, m.parentId ?? null, m.title, worktree ? worktree.path : m.cwd, m.kind, { model: m.model ?? 'claude-sonnet-5-5', ...git }, { ...(m.role && { role: m.role }), ...(worktree && { worktree }) });
        broadcast({ t: 'node', node: nodes.get(id) });
        break;
      }
      case 'history': {
        const q = m.query?.toLowerCase();
        send({ t: 'history', items: archive.filter((a) => (!m.rootId || a.rootId === m.rootId) && (!q || [a.title, a.prompt, a.lastAssistantMessage, a.brief].some((x) => x?.toLowerCase().includes(q)))) });
        break;
      }
      case 'transcript': send({ t: 'transcript', id: m.id, ...(m.sessionId && { sessionId: m.sessionId }), ...transcriptFor(m.id, m.sessionId) }); break;
      case 'followup': {
        const a = archive.find((x) => x.id === m.id);
        if (!a) { send({ t: 'error', id: m.id, message: `no archived node ${m.id}` }); break; }
        const id = `n${nodes.size + 1}${Date.now() % 1000}`;
        add(id, nodes.has(a.parentId) ? a.parentId : null, m.title ?? a.title, a.cwd, 'claude', { model: a.model, activity: m.prompt.slice(0, 60) }, { ...(a.role && { role: a.role }) });
        broadcast({ t: 'node', node: nodes.get(id) });
        break;
      }
      case 'confirm': broadcast({ t: 'confirmDone', confirmId: m.confirmId }); break;
      case 'diff': send({ t: 'diff', id: m.id, ...(n?.worktree ? { base: n.worktree.base, branch: n.worktree.branch, files: FAKE_DIFF } : { error: `${m.id} has no worktree of its own to diff` }) }); break;
      case 'merge': if (n?.status.git?.dirty) send({ t: 'error', id: m.id, message: `merge refused, nothing changed: ${n.status.git.dirty} uncommitted file(s) in the worktree; commit them first` });
        else if (n?.status.git) touch(n, { git: { ...n.status.git, ahead: 0, mergedAt: Date.now() } }); break;
      case 'mute': if (n) { n.muted = m.muted || undefined; broadcast({ t: 'node', node: n }); } break;
      case 'dnd': dnd = m.on ? { on: true, ...(m.minutes && { until: Date.now() + m.minutes * MIN }) } : { on: false }; broadcast({ t: 'dnd', ...dnd }); break;
      case 'send': console.log(`send to ${m.id}:\n${m.text}`); send({ t: 'sent', id: m.id, result: { outcome: 'queued', retryable: false, messageId: `m-${Date.now()}` } }); break;
    }
  });
  ws.on('close', () => clients.delete(client));
});

http.listen(PORT, '127.0.0.1', () => console.log(`mock daemon on http://127.0.0.1:${PORT} (ws /ws, token "mock"); UI at /?k=mock after npm run ui:build`));
