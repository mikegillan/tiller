// Full-system check with the production mod loaded by the real daemon (costs a little API usage; a macOS notification will appear).
//   O8_HOME=/tmp/o8-full O8_PORT=7794 O8_DEBUG=1 npx tsx src/daemon/index.ts > /tmp/o8-full/daemon.log 2>&1 &
//   O8_HOME=/tmp/o8-full O8_PORT=7794 npx tsx spike/full-check.ts
// Covers: pane + band in a 160-column orchestrator, an approval-blocked child (toast, band count, notification, o8 attach),
// and the /o8-list, /o8-read, /o8-send slash commands. Exits non-zero on failure.
import { mkdirSync, readFileSync } from 'node:fs';
import * as pty from 'node-pty';
import { WebSocket } from 'ws';
import type { ClientMessage, NodeView, ServerMessage } from '../src/shared/protocol.js';

const PORT = process.env.O8_PORT ?? '7794';
const HOME = process.env.O8_HOME ?? '/tmp/o8-full';
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ADMIN = readFileSync(`${HOME}/admin-token`, 'utf8').trim();
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, what: string) => { if (!ok) failures++; log(`${ok ? 'PASS' : 'FAIL'} ${what}`); };
const show = (title: string, text: string) => log(`${title}:\n${text.split('\n').filter((l) => l.trim()).map((l) => `    | ${l}`).join('\n')}`);

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const nodes = new Map<string, NodeView>();
const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString()) as ServerMessage;
  if (m.t === 'snapshot') for (const n of m.nodes) nodes.set(n.id, n);
  else if (m.t === 'node') nodes.set(m.node.id, m.node);
});

async function waitFor<T>(what: string, ms: number, probe: () => T | undefined | false | Promise<T | undefined | false>): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const v = await probe();
    if (v) return v;
  }
  log(`timeout waiting for ${what}`);
  return undefined;
}
async function api(tool: string, body: object): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/${tool}`, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'X-O8-Node': 'human', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
const screen = async (id: string, lines = 60): Promise<string> => (await api('read', { nodeId: id, what: 'terminal', lines })).text ?? '';
/** GET /children as the given node, authenticated with that node's own token. */
async function children(id: string): Promise<any[]> {
  const token = readFileSync(`${HOME}/nodes/${id}/token`, 'utf8').trim();
  return (await fetch(`http://127.0.0.1:${PORT}/children`, { headers: { Authorization: `Bearer ${token}`, 'X-O8-Node': id } })).json() as Promise<any[]>;
}
const state = (id: string) => nodes.get(id)?.status;
/** Type into a node's composer: text, then Enter after a beat (so it is not read as a paste). */
async function type(id: string, text: string): Promise<void> { send({ t: 'input', id, data: text }); await sleep(400); send({ t: 'input', id, data: '\r' }); }
const idle = (id: string) => nodes.get(id)?.status.state === 'done' && !!nodes.get(id)?.status.doneSource;
const dlog = () => readFileSync(`${HOME}/daemon.log`, 'utf8');

async function main(): Promise<void> {
  await new Promise<void>((ok, fail) => { ws.once('open', ok); ws.once('error', fail); });
  send({ t: 'auth', token: ADMIN });
  await waitFor('snapshot', 5000, () => nodes.size >= 0 && ws.readyState === 1);
  await sleep(500);

  // ---- 3a: pane and band ----
  const untrusted = `/tmp/o8-untrusted-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(untrusted, { recursive: true });
  send({ t: 'spawn', kind: 'claude', title: 'orchestr8', cwd: REPO, prompt: "Using the orchestr8 MCP tools, spawn ONE claude child titled 'worker' with cwd " + REPO + " and the prompt 'Reply with exactly: WORKER READY. Then wait for messages.'. Do nothing else, then reply with exactly: ORCH READY" });
  const orch = (await waitFor('orchestrator', 5000, () => [...nodes.values()].find((n) => n.title === 'orchestr8')?.id)) ?? '';
  if (!orch) throw new Error('spawn failed');
  send({ t: 'attach', id: orch, cols: 160, rows: 50 }); // resizes the PTY to 160 columns
  const ready = await waitFor('orchestrator first Stop', 120_000, () => idle(orch) && /ORCH READY/.test(state(orch)?.lastAssistantMessage ?? ''));
  check(!!ready, 'orchestrator reached its first Stop (ORCH READY)');
  const worker = [...nodes.values()].find((n) => n.title === 'worker' && n.parentId === orch)?.id ?? '';
  check(!!worker, `worker child exists (${worker})`);
  await waitFor('worker done', 60_000, () => idle(worker));
  send({ t: 'input', id: orch, data: '/o8\r' });
  await sleep(3000);
  let scr = await screen(orch);
  show('orchestrator screen after /o8 (160 cols)', scr);
  const paneRow = scr.split('\n').find((l) => /worker/.test(l) && /\bdone\b/.test(l) && !/spawn|child titled/i.test(l));
  check(!!paneRow, `pane row shows worker title and state: ${JSON.stringify(paneRow?.trim())}`);
  const bandRow = scr.split('\n').find((l) => /orchestr8 · node .* pending/.test(l));
  check(!!bandRow, `band row: ${JSON.stringify(bandRow?.trim())}`);

  // ---- 3b: a child that blocks on the trust dialog ----
  const toasts: string[] = [];
  const t1 = Date.now();
  await type(orch, `Using the orchestr8 spawn tool, spawn a claude child titled 'approver-test' with cwd ${untrusted} and the prompt 'Reply with exactly: APPROVED OK'. Do not wait for it. Then reply with exactly: SPAWNED`);
  const child = await waitFor('approver-test child', 60_000, () => [...nodes.values()].find((n) => n.title === 'approver-test' && n.parentId === orch)?.id);
  check(!!child, `approver-test child spawned (${child}) in ${untrusted}`);
  if (!child) return;
  const t2 = Date.now();
  let seen: any;
  let sawToast = '';
  await waitFor('child blocked / toast', 30_000, async () => {
    seen = (await children(orch)).find((c) => c.id === child);
    const s = await screen(orch, 60);
    sawToast ||= s.split('\n').find((l) => /approver-test needs you|1 children need you/.test(l)) ?? '';
    return seen?.state === 'blocked' && sawToast;
  });
  log(`child view from /children: ${JSON.stringify(seen)}`);
  show('child screen', await screen(child, 30));
  check(seen?.state === 'blocked', `(a) /children shows approver-test blocked (${Date.now() - t2} ms after spawn)`);
  check(!!sawToast, `(b) orchestrator screen shows toast or band count: ${JSON.stringify(sawToast.trim())}`);
  await sleep(1500);
  const notified = dlog().split('\n').filter((l) => l.startsWith(`mod ${orch.slice(0, 6)} notified`) && /approver-test/.test(l) && /"os":true/.test(l));
  check(notified.length > 0, `(c) daemon log shows the mod ran the OS notification: ${notified[0] ?? '(none)'}`);

  // ---- 3c: attach to the blocked child and accept the dialog ----
  const p = pty.spawn('npx', ['tsx', 'src/daemon/cli.ts', 'attach', child], { cols: 100, rows: 30, cwd: REPO, env: { ...process.env, O8_HOME: HOME, O8_PORT: PORT } as Record<string, string> });
  let out = '';
  p.onData((d) => { out += d; });
  await waitFor('attach banner', 20_000, () => out.includes('press Ctrl-'));
  await sleep(1500);
  show('attached view', out.slice(-1500).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
  const accept = '\x1b[B\r'; // Down, Enter: the dialog's default option is "No, exit"
  p.write(accept);
  await sleep(300);
  const reached = await waitFor('child past the dialog', 90_000, () => ['working', 'done'].includes(state(child)?.state ?? ''));
  p.write('\x1c'); await sleep(200); p.write('d');
  await new Promise((r) => p.onExit(r));
  check(!!reached, `child proceeded after attach (state=${state(child)?.state})`);
  await waitFor('child done', 90_000, () => idle(child));
  check(/APPROVED OK/.test(state(child)?.lastAssistantMessage ?? ''), `child replied: ${JSON.stringify(state(child)?.lastAssistantMessage)}`);

  // ---- 4: slash commands ----
  await waitFor('orchestrator idle', 90_000, () => idle(orch));
  for (const [cmd, expect] of [
    [`/o8-list`, new RegExp(worker)],
    [`/o8-read ${worker}`, /WORKER READY/],
    [`/o8-send ${worker} Reply with exactly: SLASH OK`, /queued|delivered|m-[0-9a-f]{8}/],
  ] as const) {
    await type(orch, cmd + '');
    await sleep(3500);
    const s = await screen(orch, 60);
    show(`screen after ${cmd}`, s);
    check(expect.test(s.split('\n').slice(-45).join('\n')), `${cmd} produced output matching ${expect}`);
  }
  check(!!(await waitFor('worker SLASH OK', 60_000, () => idle(worker) && /SLASH OK/.test(state(worker)?.lastAssistantMessage ?? ''))), `worker replied SLASH OK: ${JSON.stringify(state(worker)?.lastAssistantMessage)}`);
  log(`daemon log ack lines:\n${dlog().split('\n').filter((l) => /^ack|notified/.test(l)).join('\n')}`);
  for (const id of [child, worker, orch]) send({ t: 'close', id });
  await sleep(500);
}

main().catch((e) => { failures++; log(`ERROR ${e}`); }).finally(() => { log(failures ? `${failures} FAILURE(S)` : 'ALL PASS'); ws.close(); process.exit(failures ? 1 : 0); });
