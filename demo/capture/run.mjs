// Records the demo: a temp daemon running real Claude agents on the sample repo, the browser UI in headless Chromium
// driven through the beats of demo-plan.md. One long video is recorded and cut into per-beat clips with ffmpeg.
//   node run.mjs [--out DIR]
// Each run uses a fresh scratch directory and a freshly made sample repo. The daemon is stopped by pid at the end.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { makeSampleRepo } from './make-sample-repo.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const { values: opts } = parseArgs({ options: { out: { type: 'string' } } });
const OUT = resolve(opts.out ?? join(homedir(), '.tiller/sessions/n-8f9599e6/demo/clips'));
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'tiller-demo-')));
const TL_HOME = join(SCRATCH, 'home');
// A stable path, so Claude's folder trust for it (recorded on the first run) carries over to later runs.
const SAMPLE = join(homedir(), '.tiller/sessions/n-8f9599e6/demo/sample-repo');

const TASK = 'Add a --json flag to the CLI, write its tests, and document it in the README. Use one worker per part, in '
  + 'worktrees, review the result, then merge.';
const COMMENT = 'Looks good. Keep the JSON on one line so it pipes cleanly into jq.';

const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The environment for the temp daemon and bin/tl: no link to the live daemon or to the Claude session running this. */
function cleanEnv(port) {
  const env = { ...process.env, TL_HOME, TL_PORT: String(port) };
  for (const k of Object.keys(env)) {
    if ((k.startsWith('TL_') && k !== 'TL_HOME' && k !== 'TL_PORT') || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT') delete env[k];
  }
  return env;
}

const freePort = () => new Promise((ok, fail) => {
  const s = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});

// ---- the daemon and a live view of its nodes ----

const nodes = new Map(); // id -> NodeView, live nodes only
const spend = new Map(); // id -> last spentUsd seen, closed nodes included
const removedAt = new Map(); // id -> ms
let ws;

function watch(port, token) {
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'auth', token })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    const seen = (n) => { nodes.set(n.id, n); if (n.spentUsd !== undefined) spend.set(n.id, n.spentUsd); };
    if (m.t === 'snapshot') m.nodes.forEach(seen);
    else if (m.t === 'node') {
      const before = nodes.get(m.node.id);
      seen(m.node);
      const s = m.node.status;
      if (!before || before.status.state !== s.state || !before.outcome !== !m.node.outcome) {
        log(`node ${m.node.id} "${m.node.title}" ${s.state}${m.node.outcome ? ` outcome=${m.node.outcome.outcome}` : ''}${s.activity ? ` (${s.activity})` : ''}`);
      }
    } else if (m.t === 'removed') { log(`removed ${m.id} "${nodes.get(m.id)?.title}"`); nodes.delete(m.id); removedAt.set(m.id, Date.now()); }
  });
  return new Promise((ok, fail) => { ws.once('open', ok); ws.once('error', fail); });
}

async function until(what, ms, probe) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    const v = probe();
    if (v) return v;
  }
  log(`timed out after ${ms / 1000}s waiting for ${what}`);
  return undefined;
}

const children = (id) => [...nodes.values()].filter((n) => n.parentId === id);
const isReviewer = (n) => n.preset === 'reviewer' || /review/i.test(n.title);
const finished = (n) => n.status.state === 'done' || n.status.exited;

// ---- main ----

const port = await freePort();
if (port === 7788) throw new Error('refusing the live daemon port');
const env = cleanEnv(port);
mkdirSync(TL_HOME, { recursive: true });
mkdirSync(OUT, { recursive: true });
makeSampleRepo(SAMPLE);
log(`scratch ${SCRATCH}, sample repo ${SAMPLE}, port ${port}`);

const daemonLog = createWriteStream(join(SCRATCH, 'daemon.log'));
const daemon = spawn(join(ROOT, 'node_modules/.bin/tsx'), [join(ROOT, 'src/daemon/index.ts')], { cwd: SCRATCH, env, stdio: ['ignore', 'pipe', 'pipe'] });
daemon.stdout.pipe(daemonLog); daemon.stderr.pipe(daemonLog);
log(`daemon pid ${daemon.pid}, log ${join(SCRATCH, 'daemon.log')}`);

const marks = []; // { beat, start, end, notes } in ms on the video's clock
const stills = [];
let browser;
try {
  const tokenFile = join(TL_HOME, 'admin-token');
  if (!(await until('daemon admin token', 30_000, () => existsSync(tokenFile) && readFileSync(tokenFile, 'utf8').trim()))) throw new Error('daemon did not start');
  const token = readFileSync(tokenFile, 'utf8').trim();
  await watch(port, token);

  browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2, colorScheme: 'dark',
    recordVideo: { dir: SCRATCH, size: { width: 1920, height: 1080 } },
  });
  const page = await ctx.newPage();
  const v0 = Date.now(); // the video's clock starts with the page
  const vt = (ms = Date.now()) => Math.max(0, ms - v0);
  const still = async (name) => { const path = join(OUT, `${name}.png`); await page.screenshot({ path }); stills.push(`${name}.png`); log(`still ${name}.png`); };
  const mark = (beat, start, notes) => { const m = { beat, start: vt(start), end: vt(), notes }; marks.push(m); log(`beat ${beat} ${m.start}-${m.end} ms`); };
  const row = (id) => page.locator(`.row[data-id="${id}"]`);
  const select = async (id) => { await row(id).click(); await sleep(400); };
  const panelOpen = async (on) => {
    const b = page.getByRole('button', { name: 'Toggle last message panel' });
    if ((await b.getAttribute('aria-pressed')) !== String(on)) await b.click();
  };

  await page.goto(`http://127.0.0.1:${port}/?k=${token}`);
  await page.getByText('No sessions yet.').first().waitFor();
  await sleep(1500);

  // 10: the task goes to one agent through the New session dialog.
  let start = Date.now();
  await page.locator('.empty').getByRole('button', { name: 'New session' }).click();
  const form = page.locator('form.form');
  await form.getByLabel('Title').pressSequentially('add --json', { delay: 60 });
  await form.getByLabel('Working directory').fill(SAMPLE);
  await form.getByLabel('Initial prompt').pressSequentially(TASK, { delay: 12 });
  await sleep(800);
  await still('10-task-dialog');
  await form.getByRole('button', { name: 'Spawn' }).click();
  const orch = await until('orchestrator', 15_000, () => [...nodes.values()].find((n) => n.parentId === null)?.id);
  if (!orch) throw new Error('the orchestrator did not appear');
  let notes10 = '';
  // First run only: Claude asks whether to trust the new folder; answer it in the terminal.
  const asksTrust = (s) => /Trust dialog/.test(s?.activity ?? '');
  const launched = await until('orchestrator to start or ask for trust', 60_000, () => {
    const s = nodes.get(orch)?.status;
    return (s?.state === 'working' || asksTrust(s)) && s;
  });
  if (asksTrust(launched)) {
    log('answering the folder-trust dialog');
    notes10 = 'Includes Claude\'s folder-trust dialog being accepted (first run on this sample path); trim it. ';
    await page.locator('.xterm').first().click();
    await page.keyboard.press('Enter');
  }
  await until('orchestrator working', 90_000, () => nodes.get(orch)?.status.state === 'working');
  await sleep(6000);
  mark('10-task', start, `${notes10}New session dialog typed and spawned; the orchestrator starts in its terminal.`);

  // 20: the tree grows.
  const first = await until('first worker', 300_000, () => children(orch).length > 0);
  if (!first) throw new Error('the orchestrator spawned no workers');
  start = Date.now() - 3000;
  await until('three workers', 120_000, () => children(orch).filter((n) => !isReviewer(n)).length >= 3);
  await sleep(8000);
  await still('20-tree');
  const workers = children(orch).filter((n) => !isReviewer(n)).map((n) => n.id);
  mark('20-tree', start, `${workers.length} workers spawned: ${workers.map((id) => `${nodes.get(id)?.title} (${nodes.get(id)?.worktree ? 'worktree' : 'no worktree'})`).join(', ')}.`);

  // 30: a worker finishes and its outcome shows.
  const doneId = await until('a worker outcome', 900_000, () => workers.find((id) => nodes.get(id)?.outcome));
  let diffId;
  if (doneId) {
    start = Date.now();
    await select(doneId);
    await panelOpen(true);
    await sleep(8000);
    await still('30-outcome');
    mark('30-watch', start, `"${nodes.get(doneId)?.title}" reported ${nodes.get(doneId)?.outcome?.outcome}; last-message panel shows its outcome.`);
    diffId = doneId;
  }

  // 40: review its diff and send a line comment back.
  diffId = [diffId, ...workers].find((id) => {
    const n = id && nodes.get(id);
    return n?.worktree && n.status.git && n.status.git.ahead + n.status.git.dirty > 0;
  });
  if (diffId) {
    start = Date.now();
    await select(diffId);
    await panelOpen(false);
    await page.locator('.seg.tabs').getByRole('button', { name: 'Diff' }).click();
    await page.locator('.diffbody').waitFor({ timeout: 20_000 });
    await sleep(2500);
    const src = page.locator('nav.files .file', { hasText: 'src/cli.js' });
    if (await src.count()) { await src.first().click(); await sleep(1500); }
    const added = page.locator('.dl.add');
    await added.nth(Math.min(2, (await added.count()) - 1)).click();
    await page.getByLabel('Comment').pressSequentially(COMMENT, { delay: 35 });
    await sleep(600);
    await page.getByRole('button', { name: 'Add comment' }).click();
    await sleep(1500);
    await still('40-diff-comment');
    await page.getByRole('button', { name: /^Send \d+ comment/ }).click();
    await sleep(4000);
    mark('40-diff', start, `Diff of "${nodes.get(diffId)?.title}", one line comment added and sent.`);
  } else log('no worker with changes to diff');

  // 50: the reviewer.
  const reviewer = await until('a reviewer node', 600_000, () => [...nodes.values()].find(isReviewer)?.id);
  if (reviewer) {
    start = Date.now();
    await page.locator('.seg.tabs').getByRole('button', { name: 'Terminal' }).click().catch(() => {});
    await select(reviewer);
    await sleep(8000);
    await still('50-review');
    mark('50-review', start, `Reviewer "${nodes.get(reviewer)?.title}" (preset ${nodes.get(reviewer)?.preset ?? 'none'}) at work.`);
  }

  // 55: merges, and the tree shrinks as workers close.
  await select(orch);
  const firstClose = await until('a worker to close', 1_200_000, () => workers.find((id) => removedAt.has(id)));
  if (firstClose) {
    start = removedAt.get(firstClose) - 4000;
    await until('all workers closed', 300_000, () => workers.every((id) => removedAt.has(id)) && (!reviewer || !nodes.has(reviewer)));
    await sleep(4000);
    await still('55-merge');
    mark('55-merge', start, `Workers closed after merge: ${workers.filter((id) => removedAt.has(id)).length} of ${workers.length}.`);
  }

  // 60: history.
  await until('orchestrator turn to end', 600_000, () => finished(nodes.get(orch)) && children(orch).length === 0);
  await sleep(2000);
  start = Date.now();
  await page.getByRole('button', { name: 'History' }).click();
  await page.locator('.arch').first().waitFor({ timeout: 15_000 });
  await sleep(3000);
  await still('60-history-list');
  await page.locator('.arch', { has: page.locator('.branch') }).first().click();
  await sleep(3000);
  await still('60-history-node');
  await page.mouse.move(1100, 700);
  await page.mouse.wheel(0, 600);
  await sleep(3000);
  mark('60-history', start, 'History panel, then one closed worker with its brief, branch fate line and transcript.');

  // The orchestrator's final state, for the end of the story.
  start = Date.now();
  await page.getByRole('button', { name: 'History' }).click();
  await select(orch);
  await panelOpen(true);
  await sleep(5000);
  await still('70-final');
  mark('70-final', start, 'The orchestrator with its final message in the last-message panel.');

  await ctx.close();
  renameSync(await page.video().path(), join(OUT, 'full.webm'));
} finally {
  await browser?.close();
  ws?.close();
  const tl = spawnSync(join(ROOT, 'bin/tl'), ['list'], { env, encoding: 'utf8' });
  writeFileSync(join(OUT, 'tl-list.txt'), tl.stdout + tl.stderr);
  daemon.kill('SIGTERM');
  await until('daemon exit', 15_000, () => daemon.exitCode !== null || daemon.signalCode !== null);
  log(`daemon stopped (${daemon.exitCode ?? daemon.signalCode})`);
}

// ---- cut the clips ----

const clips = [];
for (const m of marks) {
  const file = `${m.beat}.mp4`;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(m.start / 1000), '-to', String(m.end / 1000), '-i', join(OUT, 'full.webm'),
    '-an', '-r', '30', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', join(OUT, file)], { encoding: 'utf8' });
  if (r.status !== 0) { log(`ffmpeg failed for ${file}: ${r.stderr}`); continue; }
  clips.push({ beat: m.beat, file, durationMs: m.end - m.start, startInFullMs: m.start, notes: m.notes });
}
const totalUsd = [...spend.values()].reduce((a, b) => a + b, 0);
writeFileSync(join(OUT, 'clips.json'), JSON.stringify({ clips, stills, full: 'full.webm', totalUsd: Number(totalUsd.toFixed(2)), recordedAt: new Date(t0).toISOString() }, null, 2) + '\n');
log(`wrote ${clips.length} clips and clips.json to ${OUT}; agent spend $${totalUsd.toFixed(2)}`);
