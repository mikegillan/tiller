// Restart resilience: a message queued for a busy worker survives a daemon SIGTERM + restart (same home and port)
// and is delivered through the mod after the worker is resumed. Starts and stops its own daemon; kill any other one first.
//   O8_HOME=/tmp/o8-full O8_PORT=7794 npx tsx spike/restart-check.ts
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, openSync, readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import type { ClientMessage, NodeView, ServerMessage } from '../src/shared/protocol.js';

const PORT = process.env.O8_PORT ?? '7794';
const HOME = process.env.O8_HOME ?? '/tmp/o8-full';
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, what: string) => { if (!ok) failures++; log(`${ok ? 'PASS' : 'FAIL'} ${what}`); };
const dlog = () => readFileSync(`${HOME}/daemon.log`, 'utf8');

async function waitFor<T>(what: string, ms: number, probe: () => T | undefined | false): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) { const v = probe(); if (v) return v; }
  log(`timeout waiting for ${what}`);
  return undefined;
}
async function startDaemon() {
  const out = openSync(`${HOME}/daemon.log`, 'a');
  appendFileSync(`${HOME}/daemon.log`, '\n=== daemon start ===\n');
  const p = spawn('node', ['--import', 'tsx', 'src/daemon/index.ts'], { cwd: REPO, env: { ...process.env, O8_HOME: HOME, O8_PORT: PORT, O8_DEBUG: '1' }, stdio: ['ignore', out, out] });
  const exited = new Promise<number | null>((r) => p.on('exit', (c) => r(c)));
  await waitFor('daemon listening', 20_000, () => dlog().split('=== daemon start ===').pop()!.includes('listening'));
  return { p, exited };
}
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const nodes = new Map<string, NodeView>();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString()) as ServerMessage;
    if (m.t === 'snapshot') for (const n of m.nodes) nodes.set(n.id, n);
    else if (m.t === 'node') nodes.set(m.node.id, m.node);
    else if (m.t === 'error') log(`ws error ${m.message}`);
  });
  await new Promise<void>((ok, fail) => { ws.once('open', ok); ws.once('error', fail); });
  const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
  send({ t: 'auth', token: readFileSync(`${HOME}/admin-token`, 'utf8').trim() });
  await waitFor('snapshot', 5000, () => nodes.size > 0 || ws.readyState === 1);
  await sleep(500);
  return { ws, nodes, send };
}
async function api(tool: string, body: object): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/${tool}`, { method: 'POST', headers: { Authorization: `Bearer ${readFileSync(`${HOME}/admin-token`, 'utf8').trim()}`, 'X-O8-Node': 'human', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

async function main(): Promise<void> {
  let d = await startDaemon();
  let c = await connect();
  c.send({ t: 'spawn', kind: 'claude', title: 'busy-worker', cwd: REPO, prompt: "Run the Bash command `sleep 75` and wait for it, then reply with exactly: LONG DONE" });
  const id = (await waitFor('worker', 10_000, () => [...c.nodes.values()].find((n) => n.title === 'busy-worker')?.id)) ?? '';
  check(!!(await waitFor('worker busy in Bash', 60_000, () => /Bash/.test(c.nodes.get(id)?.status.activity ?? ''))), `worker is busy: ${c.nodes.get(id)?.status.activity}`);
  await sleep(3000); // let the mod poll so the node counts as mod-live
  const r = await api('send', { nodeId: id, text: 'Reply with exactly: AFTER RESTART' });
  log(`send result: ${JSON.stringify(r.data)}`);
  check(r.data?.outcome === 'queued', 'message to the busy worker is queued');
  await sleep(2500);
  const stored = () => (existsSync(`${HOME}/inbox.json`) ? readFileSync(`${HOME}/inbox.json`, 'utf8') : '');
  check(stored().includes('AFTER RESTART'), `inbox.json holds the message before SIGTERM: ${stored().slice(0, 160)}`);

  d.p.kill('SIGTERM');
  log(`daemon exited with ${await d.exited}`);
  c.ws.close();
  await sleep(1000);
  check(stored().includes('AFTER RESTART'), 'inbox.json still holds the message after SIGTERM');

  d = await startDaemon();
  c = await connect();
  const before = c.nodes.get(id);
  log(`after restart, worker: state=${before?.status.state} exited=${before?.status.exited}`);
  check(!!before, 'worker is listed after restart');
  c.send({ t: 'resume', id });
  await waitFor('resumed', 30_000, () => c.nodes.get(id)?.status.exited === false || c.nodes.get(id)?.status.state === 'working');
  const gotAck = await waitFor('ack', 120_000, () => dlog().split('=== daemon start ===').pop()!.includes(`ack ${id.slice(0, 6)}`));
  check(!!gotAck, 'queued message was acked (delivered via inbox) after resume');
  await waitFor('worker replied', 120_000, () => /AFTER RESTART/.test(c.nodes.get(id)?.status.lastAssistantMessage ?? '') && c.nodes.get(id)?.status.state === 'done');
  check(/AFTER RESTART/.test(c.nodes.get(id)?.status.lastAssistantMessage ?? ''), `worker reply: ${JSON.stringify(c.nodes.get(id)?.status.lastAssistantMessage)}`);
  log(`daemon log since restart:\n${dlog().split('=== daemon start ===').pop()!.split('\n').filter((l) => /^ack|mod /.test(l)).join('\n')}`);
  const ps = await new Promise<string>((ok) => { const p = spawn('ps', ['-axww', '-o', 'args']); let o = ''; p.stdout.on('data', (x) => (o += x)); p.on('close', () => ok(o)); });
  check(ps.split('\n').some((l) => l.includes('--resume') && l.includes('--plugin-dir')), 'resumed claude was launched with --resume and --plugin-dir');
  c.send({ t: 'close', id });
  await sleep(500);
  d.p.kill('SIGTERM');
  await d.exited;
}

main().catch((e) => { failures++; log(`ERROR ${e}`); }).finally(() => { log(failures ? `${failures} FAILURE(S)` : 'ALL PASS'); process.exit(failures ? 1 : 0); });
