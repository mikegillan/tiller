// Manual end-to-end check of the real Claude Code launch path (costs a little API usage).
//   npm run ui:build
//   O8_HOME=/tmp/o8-e2e O8_PORT=7799 npx tsx src/daemon/index.ts > /tmp/o8-e2e/daemon.log &
//   O8_TOKEN=<the ?k= value in the daemon log> npx tsx spike/e2e.ts
// Exits non-zero if any assertion fails. Run it against a fresh O8_HOME.
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { WebSocket } from 'ws';
import type { ClientMessage, NodeView, ServerMessage } from '../src/shared/protocol.js';

const PORT = process.env.O8_PORT ?? '7799';
const HOME = process.env.O8_HOME ?? '/tmp/o8-e2e';
const TOKEN = process.env.O8_TOKEN ?? '';
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, what: string) => { if (!ok) failures++; log(`${ok ? 'PASS' : 'FAIL'} ${what}`); };

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const nodes = new Map<string, NodeView>();
const history: ServerMessage[] = [];
const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
const flags = (n: NodeView) => ['errored', 'interrupted', 'stale', 'exited'].filter((f) => (n.status as unknown as Record<string, unknown>)[f]).join(',');

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString()) as ServerMessage;
  history.push(m);
  if (m.t === 'snapshot') for (const n of m.nodes) nodes.set(n.id, n);
  else if (m.t === 'node') {
    nodes.set(m.node.id, m.node);
    log(`node ${m.node.id.slice(0, 6)} ${m.node.title} state=${m.node.status.state} activity=${JSON.stringify(m.node.status.activity ?? '')} flags=[${flags(m.node)}] sid=${m.node.status.sessionId?.slice(0, 8) ?? ''}`);
  } else if (m.t === 'removed') { nodes.delete(m.id); log(`removed ${m.id.slice(0, 6)}`); }
  else if (m.t === 'data') log(`data ${m.id.slice(0, 6)} ${JSON.stringify(m.data.slice(0, 80))}`);
  else log(`${m.t} ${JSON.stringify(m).slice(0, 200)}`);
});

/** Resolve when `pred` holds for any message received from now on (or already in `history` from index `from`). */
async function waitFor<T>(what: string, ms: number, probe: () => T | undefined | false): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = probe();
    if (v) return v;
  }
  log(`timeout waiting for ${what}`);
  return undefined;
}
const state = (id: string) => nodes.get(id)?.status.state;
const seen = (from: number, f: (m: ServerMessage) => boolean) => history.slice(from).some(f);

async function spawn(title: string, cwd: string, prompt: string): Promise<string> {
  const from = history.length;
  send({ t: 'spawn', kind: 'claude', title, cwd, prompt });
  const id = await waitFor('spawn', 5000, () => history.slice(from).find((m): m is Extract<ServerMessage, { t: 'node' }> => m.t === 'node' && m.node.title === title)?.node.id);
  if (!id) throw new Error('spawn failed');
  return id;
}
const typeInto = (id: string, data: string) => send({ t: 'input', id, data });
async function attachText(id: string): Promise<string> {
  const from = history.length;
  send({ t: 'attach', id, cols: 120, rows: 40 });
  await sleep(1500);
  return history.slice(from).flatMap((m) => (m.t === 'data' && m.id === id ? [m.data] : [])).join('');
}

async function main(): Promise<void> {
  await new Promise<void>((ok, fail) => { ws.once('open', ok); ws.once('error', fail); });
  send({ t: 'auth', token: TOKEN });
  await waitFor('snapshot', 5000, () => history.some((m) => m.t === 'snapshot'));

  // a + b: trusted cwd
  log('--- a/b: trusted cwd');
  let mark = history.length;
  const n1 = await spawn('e2e', REPO, 'Reply with exactly: HELLO E2E');
  check(!!(await waitFor('working', 30_000, () => state(n1) === 'working')), 'n1 reached working');
  check(!!(await waitFor('done', 120_000, () => state(n1) === 'done')), 'n1 reached done');
  check(seen(mark, (m) => m.t === 'notify' && m.id === n1 && m.kind === 'done'), 'notify kind=done for n1');
  const s1 = nodes.get(n1)!.status;
  check(!!s1.sessionId && !!s1.transcriptPath, `n1 sessionId/transcriptPath set (${s1.sessionId} ${s1.transcriptPath})`);
  check(/HELLO E2E/.test(s1.lastAssistantMessage ?? ''), `n1 lastAssistantMessage=${JSON.stringify(s1.lastAssistantMessage)}`);
  const sb1 = await attachText(n1);
  check(sb1.includes('HELLO E2E'), 'attach scrollback contains HELLO E2E');

  // c: untrusted cwd
  log('--- c: untrusted cwd');
  const tmp = mkdtempSync('/tmp/o8-untrusted-');
  mark = history.length;
  const n2 = await spawn('e2e-trust', tmp, 'Reply with exactly: TRUST OK');
  check(!!(await waitFor('blocked', 25_000, () => state(n2) === 'blocked' && nodes.get(n2)!.status.activity === 'Trust dialog: answer it in the terminal')), 'n2 blocked with trust activity');
  typeInto(n2, '\x1b[B'); await sleep(300); typeInto(n2, '\r');
  check(!!(await waitFor('working', 60_000, () => state(n2) === 'working')), 'n2 working after trust answered');
  check(!!(await waitFor('done', 120_000, () => state(n2) === 'done')), 'n2 done');
  check(!!nodes.get(n2)?.status.sessionId && /TRUST OK/.test(nodes.get(n2)?.status.lastAssistantMessage ?? ''), 'n2 sessionId + reply');

  // d: interrupt (on n1)
  log('--- d: interrupt');
  typeInto(n1, 'Write a 1500 word essay on the history of tea, no tools\r');
  check(!!(await waitFor('working', 30_000, () => state(n1) === 'working')), 'n1 working on third turn');
  await sleep(3000);
  typeInto(n1, '\x1b');
  const ok = await waitFor('done', 15_000, () => state(n1) === 'done');
  log(`after Esc: state=${state(n1)} flags=[${flags(nodes.get(n1)!)}]`);
  check(!!ok && !!nodes.get(n1)!.status.interrupted, 'n1 done with interrupted=true');

  // e: close + exit/resume
  log('--- e: close, exit, resume');
  mark = history.length;
  send({ t: 'close', id: n1 });
  check(!!(await waitFor('removed', 5000, () => seen(mark, (m) => m.t === 'removed' && m.id === n1))), 'removed arrived for n1');
  await sleep(300);
  check(!readdirSync(`${HOME}/nodes`).includes(n1), 'n1 node dir deleted');

  typeInto(n2, '/exit\r');
  check(!!(await waitFor('exited', 30_000, () => nodes.get(n2)?.status.exited)), 'n2 exited after /exit');
  mark = history.length;
  send({ t: 'resume', id: n2 });
  const sid = nodes.get(n2)!.status.sessionId;
  check(!!(await waitFor('SessionStart', 60_000, () => seen(mark, (m) => m.t === 'node' && m.node.id === n2 && !m.node.status.exited && m.node.status.state === 'unknown'))), 'n2 resumed (relaunched, state unknown)');
  await sleep(4000);
  if (history.slice(mark).some((m) => m.t === 'error')) check(false, 'resume produced an error message');
  mark = history.length;
  typeInto(n2, 'What did you reply earlier? One line.\r');
  check(!!(await waitFor('working', 30_000, () => state(n2) === 'working')), 'n2 working after resume');
  check(!!(await waitFor('done', 120_000, () => state(n2) === 'done')), 'n2 done after resume');
  const st = nodes.get(n2)!.status;
  check(/TRUST OK/.test(st.lastAssistantMessage ?? ''), `resumed session remembers: ${JSON.stringify(st.lastAssistantMessage)}`);
  check(st.sessionId === sid || !!st.sessionId, `sessionId after resume ${st.sessionId} (before ${sid})`);
  send({ t: 'close', id: n2 });
  await sleep(500);

  // f: UI
  log('--- f: UI');
  const root = await fetch(`http://127.0.0.1:${PORT}/`);
  const html = await root.text();
  check(root.status === 200 && html.includes('<div id="root"'), `GET / serves UI (${root.status})`);
  const asset = /\/assets\/[^"']+\.js/.exec(html)?.[0];
  const a = asset ? await fetch(`http://127.0.0.1:${PORT}${asset}`) : undefined;
  check(a?.status === 200 && (a.headers.get('content-type') ?? '').includes('javascript'), `GET ${asset} ok`);
  check(!existsSync(`${HOME}/nodes/${n1}`), 'no leftover dir');
}

main().catch((e) => { failures++; log(`ERROR ${e}`); }).finally(() => { log(failures ? `${failures} FAILURE(S)` : 'ALL PASS'); ws.close(); process.exit(failures ? 1 : 0); });
