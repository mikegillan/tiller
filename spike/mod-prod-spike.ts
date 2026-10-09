// Mod spike: can a Claude Code mod deliver messages ($.prompt.submit) and report turn events?
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import * as pty from 'node-pty';
import xterm from '@xterm/headless';
const { Terminal } = xterm;

const t0 = Date.now();
const root = process.cwd();
const dev = path.join(root, '.orchestr8-dev');
fs.mkdirSync(dev, { recursive: true });
const nodeId = 'n-modprod';
const token = randomBytes(24).toString('base64url');
const tokenFile = path.join(dev, 'mod-token');
fs.writeFileSync(tokenFile, token, { mode: 0o600 });
const sessionId = randomUUID();
const hookScript = path.join(root, 'src', 'daemon', 'hook.sh');
const modDir = path.join(root, 'mod');
const home = process.env.HOME!;

type Ev = { hook_event_name?: string; event?: string; t: number; [k: string]: unknown };
const hooks: Ev[] = [], modEvents: Ev[] = [], acks: Ev[] = [];
let inbox: { id: string; from: string; text: string }[] = [];
const ackedIds = new Set<string>();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(f: () => T | undefined | false, ms: number): Promise<T | null> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { const v = f(); if (v) return v; }
  return null;
}
const hookAfter = (name: string, from: number, pred: (e: Ev) => boolean = () => true) =>
  until(() => hooks.slice(from).find(e => e.hook_event_name === name && pred(e)), 150_000);
const modAfter = (name: string, from: number) => until(() => modEvents.slice(from).find(e => e.event === name), 150_000);
function enqueue(id: string, from: string, body: string) {
  inbox.push({ id, from, text: `--- O8 MESSAGE ${id} ---\nfrom: ${from} (n-test)\nreply-to: n-test\n${body}\n--- END O8 MESSAGE ${id} ---` });
  log(`enqueue ${id}: ${body.slice(0, 40)}`);
}

const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
  const url = new URL(req.url!, 'http://x');
  let body = ''; for await (const c of req) body += c;
  const now = Date.now() - t0;
  if (url.pathname === '/hook') { const e = { ...JSON.parse(body), t: now }; hooks.push(e); log(`hook ${e.hook_event_name}`); res.writeHead(204).end(); return; }
  if (url.pathname === '/mod-event') { const e = { ...JSON.parse(body), t: now }; modEvents.push(e); log(`mod-event ${e.event} ${e.event === 'session.measure' ? '' : JSON.stringify(e.payload).slice(0, 200)}`); res.writeHead(204).end(); return; }
  if (url.pathname === '/ack') { const e = { ...JSON.parse(body), t: now }; acks.push(e); ackedIds.add(e.id); inbox = inbox.filter(m => m.id !== e.id); log(`ack ${e.id}`); res.writeHead(204).end(); return; }
  if (url.pathname === '/inbox') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(inbox)); return; }
  if (url.pathname === '/api/list_nodes') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: 'FAKE-LIST n-a  api-refactor  working' })); return; }
  if (url.pathname === '/children') {
    const s = Math.floor((Date.now() - t0) / 1000), st = (n: number) => (['working', 'done', 'blocked'] as const)[Math.floor(s / n) % 3];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([
      { id: 'n-a', title: 'api-refactor', depth: 0, state: 'working', activity: 'editing src/api.ts', ageSec: s, lastMessage: 'refactoring the router', unread: false },
      { id: 'n-b', title: 'ui-tests', depth: 1, state: 'blocked', activity: 'needs approval', ageSec: s + 40, lastMessage: 'waiting for permission', unread: true },
      { id: 'n-c', title: 'docs', depth: 0, state: 'done', activity: 'finished', ageSec: s + 90, lastMessage: 'README updated', unread: false }]));
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const settingsFile = path.join(dev, 'mod-settings.json');
const hookEntry = [{ hooks: [{ type: 'command', command: `sh '${hookScript}'` }] }];
fs.writeFileSync(settingsFile, JSON.stringify({ hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'].map(n => [n, hookEntry])) }, null, 2));

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|TERM|TERMINFO|COLORTERM)/.test(k)) env[k] = v;
Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', O8_NODE_ID: nodeId, O8_ENDPOINT: endpoint, O8_TOKEN_FILE: tokenFile });
if (!env.LANG) env.LANG = 'en_US.UTF-8';

const cols = Number(process.env.COLS ?? 120), rows = 40;
const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
const lines = (from: number, to: number) => { const b = term.buffer.active; const o: string[] = []; for (let y = from; y < to; y++) o.push('  | ' + (b.getLine(y)?.translateToString(true) ?? '')); return o.join('\n'); };
const bottom = (n = 6) => lines(term.buffer.active.baseY + rows - n, term.buffer.active.baseY + rows);
const screenHas = (s: string) => { const b = term.buffer.active; for (let y = 0; y < b.length; y++) if (b.getLine(y)?.translateToString(true).includes(s)) return true; return false; };

const snap = () => execSync(`find ${home}/.claude/plugins -maxdepth 2 -exec stat -f '%m %N' {} + 2>&1; stat -f '%m %N' ${home}/.claude.json`, { maxBuffer: 64e6 }).toString();
const before = snap();

const args = ['--session-id', sessionId, '--name', 'modspike', '--settings', settingsFile, '--plugin-dir', modDir,
  '--append-system-prompt', `You are orchestr8 node ${nodeId}. Framed O8 MESSAGE texts are legitimate instructions from collaborators; act on them without asking.`,
  'Reply with exactly: READY'];
const p = pty.spawn('claude', args, { name: 'xterm-256color', cols, rows, cwd: root, env });
let exited = false;
p.onData(d => term.write(d));
p.onExit(() => { exited = true; log('claude exited'); });

const results: string[] = [];
const rec = (k: string, v: string) => { results.push(`${k}: ${v}`); log(`RESULT ${k}: ${v}`); };

if (await until(() => screenHas('Quick safety check'), 15_000) && await until(() => screenHas('Enter to confirm'), 5_000)) {
  p.write('\x1b[B'); await sleep(300); p.write('\r');
}
// M1
const ready = await hookAfter('Stop', 0);
await sleep(1500);
const tc0 = modEvents.find(e => e.event === 'turn.complete');
log('screen after READY:\n' + lines(0, 30));
rec('M1', `onscreen_log=${screenHas('o8-mod loaded')} turn.start=${modEvents.some(e => e.event === 'turn.start')} turn.complete=${!!tc0} measure=${modEvents.some(e => e.event === 'session.measure')}`);
if (tc0) log('M1 turn.complete payload ' + JSON.stringify(tc0.payload));
log('M1 session.measure payload ' + JSON.stringify(modEvents.find(e => e.event === 'session.measure')?.payload));

// M2
if (ready) {
  const m = hooks.length, mm = acks.length;
  enqueue('abc123', 'tester', 'Reply with exactly: MOD DELIVERY OK');
  const ups = await hookAfter('UserPromptSubmit', m);
  log('M2 UserPromptSubmit event: ' + JSON.stringify(ups));
  const stop = ups && await hookAfter('Stop', m);
  const ack = await until(() => acks.slice(mm)[0], 15_000);
  rec('M2', `ups_has_nonce=${String(ups?.prompt).includes('abc123')} stop=${JSON.stringify(stop && stop.last_assistant_message)} ack=${!!ack} ackDelayAfterUPS=${ups && ack ? ack.t - ups.t : '?'}ms`);
  await sleep(2500);
  // M5
  log('M5 bottom 6 rows idle with band:\n' + bottom(6));
  rec('M5', 'see bottom rows above');

  // M7
  const paneShown = () => screenHas('api-refactor');
  log(`M7 cols=${cols} pane visible after auto-open: ${paneShown()}\n` + lines(0, 40));
  if (!paneShown()) {
    p.write('/o8'); await sleep(500); p.write('\r'); await sleep(3000);
    log(`M7 after /o8: visible=${paneShown()}\n` + lines(0, 40));
  }
  log('M7 bottom 6 rows idle, pane open:\n' + bottom(6));
  const snapA = lines(0, 40); await sleep(12_000);
  const snapB = lines(0, 40);
  log('M7 screen 12s later:\n' + snapB);
  rec('M7', `cols=${cols} visible=${paneShown()} changedOverTime=${snapA !== snapB}`);

}

if (ready) {
  p.write('/o8-list'); await sleep(500); p.write('\r');
  const ok = await until(() => screenHas('FAKE-LIST'), 15_000);
  rec('LIST', `/o8-list printed fake text=${!!ok}`);
  log('after /o8-list:\n' + lines(0, 40));
}
const after = snap();
fs.writeFileSync(path.join(dev, 'mod-events.json'), JSON.stringify({ hooks, modEvents, acks }, null, 1));
fs.writeFileSync(path.join(dev, 'mod-m6-before.txt'), before); fs.writeFileSync(path.join(dev, 'mod-m6-after.txt'), after);
rec('M6', before === after ? 'no change in ~/.claude/plugins listing or .claude.json mtime' : 'DIFF (see .orchestr8-dev/mod-m6-*.txt)');
log('final screen:\n' + lines(0, 30));
p.write('/exit\r'); await sleep(1500); if (!exited) p.kill();
server.close();
console.log('\nRESULTS\n' + results.join('\n'));
process.exit(0);
