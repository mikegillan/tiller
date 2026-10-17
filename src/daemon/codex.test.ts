import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexAdapter } from './harness.js';
import { codexHeader } from './codex-session.js';
import { NodeManager } from './manager.js';
import { startServer, type DaemonServer } from './server.js';
import { DAEMON, deliver, HUMAN, messageStatus } from './messaging.js';

let home: string, manager: NodeManager | undefined, server: DaemonServer | undefined;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tl-codex-')); });
afterEach(async () => {
  await manager?.shutdown(); await server?.close(); manager = undefined; server = undefined;
  rmSync(home, { recursive: true, force: true });
});

// The real bridge talks to a fake native app-server and the real authenticated daemon.
async function setup(): Promise<void> {
  const bin = join(home, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
if (process.argv.includes('--remote')) {
 appendFileSync(${JSON.stringify(join(home, 'rpc.jsonl'))}, JSON.stringify({ method: 'tui/launch', params: { args: process.argv.slice(2) } }) + '\\n');
 const WebSocket = require(${JSON.stringify(fileURLToPath(new URL('../../node_modules/ws/index.js', import.meta.url)))});
 const remote = process.argv[process.argv.indexOf('--remote') + 1];
 const ws = new WebSocket('ws+unix://' + remote.slice('unix://'.length) + ':/');
 let threadId, nextId = 10;
 const send = p => ws.send(JSON.stringify(p));
 ws.on('open', () => send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-tui', version: 'fake' } } }));
 ws.on('message', raw => {
  const p = JSON.parse(raw);
  if (p.id === 1 && !p.method) {
   send({ method: 'initialized' });
   const resume = process.argv.indexOf('resume');
   send({ id: 2, method: resume >= 0 ? 'thread/resume' : 'thread/start', params: resume >= 0 ? { threadId: process.argv[resume + 1] } : {} });
  } else if (p.id === 2 && !p.method) {
   threadId = p.result.thread.id;
   console.log('FAKE CODEX TUI ready');
   const prompt = process.argv.indexOf('--');
   if (prompt >= 0) send({ id: ++nextId, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: process.argv[prompt + 1] }] } });
  } else if (p.method === 'item/commandExecution/requestApproval') console.log('NATIVE APPROVAL ' + p.id);
 });
 createInterface({ input: process.stdin }).on('line', line => {
  if (line === '/approve approval yes') send({ id: 'approval', result: { decision: 'accept' } });
 });
 process.on('SIGTERM', () => process.exit());
} else {
const send = p => process.stdout.write(JSON.stringify(p) + '\\n');
const reply = (p, result) => send({ id: p.id, result });
let threadId, turn, seq = 0;
const event = (method, params) => send({ method, params: { threadId, ...params } });
function complete(status = 'completed') {
  const text = 'Codex received: ' + turn.text;
  event('item/agentMessage/delta', { delta: text });
  event('item/completed', { item: { type: 'agentMessage', id: 'answer', text } });
  event('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 200 }, modelContextWindow: 1000 } });
  event('turn/completed', { turn: { id: turn.id, status } }); turn = undefined;
}
createInterface({ input: process.stdin }).on('line', line => {
  const p = JSON.parse(line), v = p.params || {};
  appendFileSync(${JSON.stringify(join(home, 'rpc.jsonl'))}, JSON.stringify(p) + '\\n');
  if (!p.method) { if (p.id === 'approval') complete(); return; }
  if (p.method === 'initialize') return reply(p, {});
  if (p.method === 'initialized') return;
  if (['thread/start', 'thread/resume', 'thread/fork'].includes(p.method)) {
    if (p.method === 'thread/start') threadId = 'native-' + process.pid;
    else threadId = p.method === 'thread/fork' ? 'fork-' + process.pid : v.threadId;
    const mcp = v.config ? Object.values(v.config)[0] : undefined;
    if (v.config && (!mcp.required || mcp.http_headers['X-TL-Node'] !== process.env.TL_NODE_ID || !process.env.TL_CODEX_AUTHORIZATION.startsWith('Bearer '))) throw Error('bad MCP identity');
    return reply(p, { thread: { id: threadId }, model: v.model || 'codex-default' });
  }
  if (p.method === 'turn/start') {
    const text = v.input[0].text;
    if (text.includes('reject-me')) return send({ id: p.id, error: { code: -1, message: 'rejected' } });
    turn = { id: 't-' + ++seq, text };
    event('turn/started', { turn: { id: turn.id } });
    event('item/completed', { item: { type: 'userMessage', id: 'user', content: v.input } });
    reply(p, { turn: { id: turn.id } });
    if (text.includes('approve-me')) return send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId, turnId: turn.id, command: 'echo hello', reason: 'test approval' } });
    if (text.includes('hold-me')) return;
    setTimeout(() => complete(), 50); return;
  }
  if (p.method === 'turn/interrupt') { reply(p, {}); complete('interrupted'); return; }
  send({ id: p.id, error: { code: -32601, message: 'unsupported' } });
});
}
`);
  chmodSync(join(bin, 'codex'), 0o755);
  manager = new NodeManager({ home: join(home, 'tl'), path: `${bin}:/usr/bin:/bin` });
  server = await startServer(manager, { port: 0 });
}
const ready = async (id: string) => {
  await expect.poll(() => manager!.session(id)?.screenTail(40).join('\n')).toContain('FAKE CODEX TUI ready');
};
const packets = () => readFileSync(join(home, 'rpc.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('Codex harness', () => {
  it('rejects restrictions that cannot be translated', () => {
    expect(() => codexAdapter.validate({ permissionMode: 'plan' })).toThrow(/permissionMode/);
    for (const preset of [{ tools: [] }, { disallowedTools: [] }, { maxTurns: 1 }]) {
      expect(() => codexAdapter.validate({ preset })).toThrow(/preset tools/);
    }
  });

  it('delivers once, reports lifecycle/context and preserves a separate native thread on follow-up', async () => {
    await setup();
    const n = await manager!.spawn({ kind: 'agent', harness: 'codex', title: 'Codex', cwd: home, effort: 'high', byHuman: true });
    await ready(n.id);
    expect(packets().filter((p) => p.method === 'tui/launch').at(-1).params.args).toContain('model_reasoning_effort="high"');
    expect(manager!.view(n.id)?.status.model).toBe('codex-default');
    expect(manager!.view(n.id)?.sessionId).toBe(n.sessionId);
    const sent = await deliver(manager!, HUMAN, n.id, 'hello');
    await expect.poll(() => messageStatus(manager!, HUMAN, sent.messageId!)?.outcome).toBe('delivered');
    await expect.poll(() => manager!.view(n.id)?.status.state).toBe('done');
    expect(manager!.view(n.id)?.status.lastAssistantMessage).toContain('hello');
    expect(manager!.view(n.id)?.status.contextPct).toBe(20);
    const entries = (await manager!.transcript(n.id)).entries;
    expect(entries.map((e) => e.role)).toEqual(['user', 'assistant']);
    expect(entries[0].text).toContain('hello');
    expect(packets().filter((p) => p.method === 'turn/start')).toHaveLength(1);
    const path = manager!.view(n.id)!.transcriptPath!, original = readFileSync(path, 'utf8');
    const nativeId = codexHeader(original).threadId;
    await manager!.close(n.id, true);
    const next = await manager!.followup(n.id, ''); await ready(next.id);
    expect(packets().filter((p) => p.method === 'tui/launch').at(-1).params.args).not.toContain('-c');
    expect(next.harness).toBe('codex');
    expect(next.transcriptPath).not.toBe(path);
    expect(codexHeader(readFileSync(next.transcriptPath!, 'utf8')).threadId).not.toBe(nativeId);
    expect(packets().some((p) => p.method === 'thread/fork' && p.params.threadId === nativeId)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect((await manager!.transcript(next.id)).entries).toEqual(entries);
    manager!.kill(next.id);
    expect((await manager!.resume(next.id)).ok).toBe(true); await ready(next.id);
    expect(packets().filter((p) => p.method === 'thread/resume').length).toBeGreaterThanOrEqual(2);
    expect(packets().filter((p) => p.method === 'tui/launch').at(-1).params.args).not.toContain('-c');
    expect(manager!.restart(next.id).ok).toBe(true); await ready(next.id);
    expect(packets().filter((p) => p.method === 'tui/launch').at(-1).params.args).toContain('model_reasoning_effort="high"');
    expect(manager!.view(next.id)?.previousSessions).toContain(n.sessionId);
    expect((await manager!.transcript(next.id, n.sessionId)).entries).toEqual(entries);
  });

  it('keeps busy messages withdrawable, interrupts on steer, and surfaces approvals for a human response', async () => {
    await setup();
    const n = await manager!.spawn({ kind: 'agent', harness: 'codex', title: 'Codex', cwd: home, prompt: 'hold-me', byHuman: true });
    await ready(n.id);
    await expect.poll(() => manager!.view(n.id)?.status.state).toBe('working');
    const queued = await deliver(manager!, DAEMON, n.id, 'queued');
    // A steer interrupts the active turn and runs ahead of the ordinary message.
    const steer = await deliver(manager!, HUMAN, n.id, 'approve-me', { mode: 'now' });
    await expect.poll(() => manager!.view(n.id)?.status.state).toBe('blocked');
    expect(messageStatus(manager!, HUMAN, queued.messageId!)?.outcome).toBe('queued');
    expect(messageStatus(manager!, HUMAN, steer.messageId!)?.outcome).toBe('delivered');
    manager!.session(n.id)!.write('/approve approval yes\r');
    await expect.poll(() => messageStatus(manager!, HUMAN, queued.messageId!)?.outcome).toBe('delivered');
    await expect.poll(() => manager!.view(n.id)?.status.state).toBe('done');
    const starts = packets().filter((p) => p.method === 'turn/start');
    expect(starts.map((p) => p.params.input[0].text.includes('approve-me'))).toEqual([false, true, false]);
    expect(packets().find((p) => p.id === 'approval' && p.result)?.result).toEqual({ decision: 'accept' });
    expect(packets().filter((p) => p.method === 'turn/interrupt')).toHaveLength(1);
  });
});
