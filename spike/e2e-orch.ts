// Manual end-to-end check of agent-to-agent messaging with real Claude nodes (costs a little API usage).
//   TL_HOME=/tmp/tl-orch TL_PORT=7797 TL_DEBUG=1 npx tsx src/daemon/index.ts > /tmp/tl-orch/daemon.log 2>&1 &
//   TL_PORT=7797 TL_TOKEN=<the ?k= value in the daemon log> npx tsx spike/e2e-orch.ts
// An "orchestrator" node spawns a "worker", messages it, and reports the worker's reply. Exits non-zero on failure.
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import type { ClientMessage, NodeView, ServerMessage } from '../src/shared/protocol.js';

const PORT = process.env.TL_PORT ?? '7797';
const HOME = process.env.TL_HOME ?? '/tmp/tl-orch';
const TOKEN = process.env.TL_TOKEN ?? '';
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, what: string) => { if (!ok) failures++; log(`${ok ? 'PASS' : 'FAIL'} ${what}`); };

const PROMPT = "Using the tiller MCP tools: 1) call list_nodes. 2) spawn a claude child titled 'worker' with cwd " + REPO + " and the prompt 'Wait for a message, then do what it says.' 3) wait about 10 seconds, then send the worker this text: 'Reply to me with the single word PINEAPPLE using the send tool.' 4) call message_status on the messageId until it is delivered or 60 seconds pass. 5) When you receive the worker's reply, call read with what=summary on the worker, then reply to the user with exactly one line: ORCH DONE <the word the worker sent> <delivered|stalled|other>. Do not ask the user for confirmation at any step.";

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const nodes = new Map<string, NodeView>();
const history: ServerMessage[] = [];
const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
const flags = (n: NodeView) => ['errored', 'interrupted', 'stale', 'exited'].filter((f) => (n.status as unknown as Record<string, unknown>)[f]).join(',');
let orch = '';
const trail = new Map<string, string[]>(); // per-node state sequence

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString()) as ServerMessage;
  history.push(m);
  if (m.t === 'snapshot') for (const n of m.nodes) nodes.set(n.id, n);
  else if (m.t === 'node') {
    const n = m.node;
    nodes.set(n.id, n);
    const seq = trail.get(n.id) ?? [];
    if (seq.at(-1) !== n.status.state) seq.push(n.status.state);
    trail.set(n.id, seq);
    log(`node ${n.id.slice(0, 6)} ${n.title} parent=${n.parentId?.slice(0, 6) ?? '-'} state=${n.status.state} activity=${JSON.stringify(n.status.activity ?? '')} flags=[${flags(n)}]`);
  } else if (m.t === 'removed') log(`removed ${m.id.slice(0, 6)}`);
  else if (m.t === 'data') { if (m.id === orch) log(`data ${JSON.stringify(m.data.slice(0, 100))}`); }
  else log(`${m.t} ${JSON.stringify(m).slice(0, 200)}`);
});

async function waitFor<T>(what: string, ms: number, probe: () => T | undefined | false): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
    const v = probe();
    if (v) return v;
  }
  log(`timeout waiting for ${what}`);
  return undefined;
}

async function api(tool: string, body: object): Promise<any> {
  const token = readFileSync(`${HOME}/admin-token`, 'utf8');
  const r = await fetch(`http://127.0.0.1:${PORT}/api/${tool}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-TL-Node': 'human', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

async function main(): Promise<void> {
  await new Promise<void>((ok, fail) => { ws.once('open', ok); ws.once('error', fail); });
  send({ t: 'auth', token: TOKEN });
  await waitFor('snapshot', 5000, () => history.some((m) => m.t === 'snapshot'));

  send({ t: 'spawn', kind: 'claude', title: 'orchestrator', cwd: REPO, prompt: PROMPT });
  orch = (await waitFor('orchestrator', 5000, () => [...nodes.values()].find((n) => n.title === 'orchestrator')?.id)) ?? '';
  if (!orch) throw new Error('spawn failed');

  const worker = await waitFor('worker child', 120_000, () => [...nodes.values()].find((n) => n.title === 'worker' && n.parentId === orch)?.id);
  check(!!worker, 'child node "worker" appeared with parentId = orchestrator');
  if (!worker) return;
  check(!!(await waitFor('worker working', 60_000, () => nodes.get(worker)?.status.state === 'working')), 'worker reached working');
  // After the orchestrator's send, the worker must go working -> done again; check the trail has done then working then done.
  const full = () => /done.*working.*done/.test((trail.get(worker) ?? []).join(' '));
  check(!!(await waitFor('worker done after send', 180_000, full)), `worker state trail: ${(trail.get(worker) ?? []).join(' > ')}`);
  check(!!(await waitFor('orchestrator final', 240_000, () => /ORCH DONE PINEAPPLE/.test(nodes.get(orch)?.status.lastAssistantMessage ?? ''))), `orchestrator lastAssistantMessage=${JSON.stringify(nodes.get(orch)?.status.lastAssistantMessage)}`);

  const term = (await api('read', { nodeId: orch, what: 'terminal', lines: 200 })).text ?? '';
  check(/PINEAPPLE/.test(term), 'orchestrator terminal mentions PINEAPPLE');
  const tree = await api('list_nodes', {});
  log(`list_nodes:\n${tree.text}`);
  check(typeof tree.text === 'string' && tree.text.includes(worker), 'admin list_nodes returns the tree including worker');
  const sum = await api('read', { nodeId: worker, what: 'summary' });
  log(`worker summary:\n${sum.text ?? JSON.stringify(sum)}`);
  check(/PINEAPPLE/.test(sum.text ?? '') && /Wait for a message/.test(sum.text ?? ''), 'admin read summary returns the worker conversation');
  for (const id of [worker, orch]) send({ t: 'close', id, force: id === orch });
  await sleep(500);
}

main().catch((e) => { failures++; log(`ERROR ${e}`); }).finally(() => { log(failures ? `${failures} FAILURE(S)` : 'ALL PASS'); ws.close(); process.exit(failures ? 1 : 0); });
