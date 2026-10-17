import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TillerClient, type InboxMessage } from '../pi/client.js';
import { CodexBridge } from './bridge.js';
import { RpcError } from './rpc.js';

let dir: string, bridge: CodexBridge;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tl-codex-bridge-')); });
afterEach(async () => { await bridge?.stop(); rmSync(dir, { recursive: true, force: true }); });

async function setup(messages: InboxMessage[], resumeHistory?: string, effort?: string) {
  const client = new TillerClient({ endpoint: 'http://unused', nodeId: 'n-1', token: 'node-token' });
  vi.spyOn(client, 'hook').mockResolvedValue();
  vi.spyOn(client, 'modEvent').mockResolvedValue();
  vi.spyOn(client, 'inbox').mockResolvedValue(messages);
  vi.spyOn(client, 'claim').mockResolvedValue(true);
  vi.spyOn(client, 'ack').mockResolvedValue();
  vi.spyOn(client, 'release').mockResolvedValue(true);
  vi.spyOn(client, 'unconfirmed').mockResolvedValue();
  const rpc = { send: vi.fn(), request: vi.fn(async (method: string, _params: Record<string, unknown>) => {
    if (method === 'thread/resume') throw new RpcError('no rollout found for thread id old');
    return method.startsWith('thread/') ? { thread: { id: 'native' }, model: 'test' } : { turn: { id: 'turn' } };
  }) };
  const fatal = vi.fn();
  if (resumeHistory !== undefined) writeFileSync(join(dir, 'session.jsonl'), JSON.stringify({ type: 'codex_session', threadId: 'old' }) + '\n' + resumeHistory);
  bridge = new CodexBridge({ transcriptPath: join(dir, 'session.jsonl'), sessionId: 'tiller-id', resume: resumeHistory !== undefined, instructions: 'role', effort }, rpc, client, vi.fn(), fatal);
  await bridge.start('http://unused', 'n-1');
  return { client, rpc, fatal };
}

describe('Codex delivery failures', () => {
  it('reports native model picker changes to Tiller', async () => {
    const { client } = await setup([]);
    bridge.handle({ method: 'thread/settings/updated', params: { threadId: 'native', threadSettings: { model: 'selected-model' } } });
    await expect.poll(() => vi.mocked(client.modEvent).mock.calls).toEqual([['session.measure', { model: 'selected-model' }]]);
  });

  it('recreates an untouched session when Codex has not persisted a rollout', async () => {
    const { rpc } = await setup([], '');
    expect(rpc.request.mock.calls.map(([m]) => m)).toEqual(['initialize', 'thread/resume', 'thread/start']);
  });

  it('refuses to replace missing native history when a conversation was recorded', async () => {
    await expect(setup([], JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n'))
      .rejects.toThrow('no rollout found');
  });

  it('retries a failed receipt without submitting the accepted prompt twice', async () => {
    const { client, rpc } = await setup([{ id: 'message', text: 'hello' }]);
    vi.mocked(client.ack).mockRejectedValueOnce(new Error('daemon unavailable'));
    await expect(bridge.poll()).rejects.toThrow('daemon unavailable');
    vi.mocked(client.inbox).mockResolvedValue([]);
    await bridge.poll();
    expect(client.ack).toHaveBeenCalledTimes(2);
    expect(rpc.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(1);
    expect(client.unconfirmed).not.toHaveBeenCalled();
  });

  it('never replays an inherited claim after a bridge restart', async () => {
    const { client, rpc } = await setup([{ id: 'old', text: 'possibly ran', claimed: true }]);
    await bridge.poll();
    expect(client.unconfirmed).toHaveBeenCalledWith('old');
    expect(client.claim).not.toHaveBeenCalled();
    expect(rpc.request.mock.calls.some(([m]) => m === 'turn/start')).toBe(false);
  });

  it('never submits a withdrawn message', async () => {
    const { client, rpc } = await setup([{ id: 'gone', text: 'hello' }]);
    vi.mocked(client.claim).mockResolvedValue(false);
    await bridge.poll();
    expect(rpc.request.mock.calls.some(([m]) => m === 'turn/start')).toBe(false);
  });

  it('releases an explicitly rejected prompt but retires an ambiguous transport failure', async () => {
    const { client, rpc, fatal } = await setup([{ id: 'message', text: 'hello' }]);
    rpc.request.mockRejectedValueOnce(new RpcError('busy'));
    await expect(bridge.poll()).rejects.toThrow('busy');
    expect(client.release).toHaveBeenCalledWith('message');
    expect(client.ack).not.toHaveBeenCalled();
    rpc.request.mockRejectedValueOnce(new Error('connection lost'));
    await expect(bridge.poll()).rejects.toThrow('connection lost');
    expect(fatal).toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
    vi.mocked(client.inbox).mockResolvedValue([]);
    await bridge.poll();
    expect(client.unconfirmed).toHaveBeenCalledWith('message');
    expect(rpc.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(2);
    expect(client.ack).not.toHaveBeenCalled();
  });
});

describe('Codex shutdown', () => {
  it('drains accepted user, tool, answer and lifecycle events and rejects later events/polls', async () => {
    const { client, fatal } = await setup([]);
    const item = (value: object) => bridge.handle({ method: 'item/completed', params: { item: value } });
    bridge.handle({ method: 'turn/started', params: { turn: { id: 'last' } } });
    item({ type: 'userMessage', content: [{ type: 'text', text: 'question' }] });
    item({ type: 'commandExecution', command: 'echo answer' });
    item({ type: 'agentMessage', text: 'final answer' });
    bridge.handle({ method: 'turn/completed', params: { turn: { id: 'last', status: 'completed' } } });
    const stopped = bridge.stop();
    item({ type: 'agentMessage', text: 'too late' });
    await bridge.poll();
    await stopped;
    const transcript = readFileSync(join(dir, 'session.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(transcript.slice(1).map((entry) => entry.message.content)).toEqual([
      [{ type: 'text', text: 'question' }], [{ type: 'tool_use', name: 'Bash' }], 'final answer',
    ]);
    expect(client.modEvent).toHaveBeenLastCalledWith('turn.complete', expect.objectContaining({ answer: 'final answer' }));
    expect(client.hook).toHaveBeenCalledWith(expect.objectContaining({ hook_event_name: 'PostToolUse' }));
    expect(client.hook).toHaveBeenLastCalledWith({ hook_event_name: 'SessionEnd' });
    expect(client.inbox).not.toHaveBeenCalled();
    expect(fatal).not.toHaveBeenCalled();
    await bridge.stop();
    expect(vi.mocked(client.hook).mock.calls.filter(([event]) => event.hook_event_name === 'SessionEnd')).toHaveLength(1);
  });

  it('does not claim an inbox response arriving after stop', async () => {
    const { client } = await setup([]);
    let resolve!: (messages: InboxMessage[]) => void;
    vi.mocked(client.inbox).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const poll = bridge.poll();
    await expect.poll(() => client.inbox).toHaveBeenCalled();
    const stopped = bridge.stop();
    resolve([{ id: 'late', text: 'hello' }]);
    await Promise.all([poll, stopped]);
    expect(client.claim).not.toHaveBeenCalled();
  });

  it('releases a claim acquired while shutdown is starting', async () => {
    const { client, rpc } = await setup([{ id: 'pending', text: 'hello' }]);
    let resolve!: (claimed: boolean) => void;
    vi.mocked(client.claim).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const poll = bridge.poll();
    await expect.poll(() => client.claim).toHaveBeenCalled();
    const stopped = bridge.stop();
    expect(client.hook).not.toHaveBeenCalledWith({ hook_event_name: 'SessionEnd' });
    resolve(true);
    await Promise.all([poll, stopped]);
    expect(client.release).toHaveBeenCalledWith('pending');
    expect(rpc.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
  });

  it.each([false, true])('settles an in-flight submission before SessionEnd (ambiguous=%s)', async (ambiguous) => {
    const { client, rpc } = await setup([{ id: 'pending', text: 'hello' }]);
    let resolve!: (value: any) => void, reject!: (error: Error) => void;
    rpc.request.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    const poll = bridge.poll().catch(() => {});
    await expect.poll(() => rpc.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(true);
    const stopped = bridge.stop();
    expect(client.hook).not.toHaveBeenCalledWith({ hook_event_name: 'SessionEnd' });
    if (ambiguous) reject(new Error('connection closed'));
    else resolve({ turn: { id: 'last' } });
    await Promise.all([poll, stopped]);
    const receipt = vi.mocked(ambiguous ? client.unconfirmed : client.ack);
    expect(receipt).toHaveBeenCalledWith('pending');
    expect(receipt.mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(client.hook).mock.invocationCallOrder.at(-1)!);
    expect(client.hook).toHaveBeenLastCalledWith({ hook_event_name: 'SessionEnd' });
  });

  it('retries a pending receipt during shutdown without resubmitting', async () => {
    const { client, rpc } = await setup([{ id: 'pending', text: 'hello' }]);
    vi.mocked(client.ack).mockRejectedValueOnce(new Error('temporary failure'));
    await expect(bridge.poll()).rejects.toThrow('temporary failure');
    await bridge.stop();
    expect(client.ack).toHaveBeenCalledTimes(2);
    expect(rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  });
});

describe('Codex inbox effort', () => {
  it.each([
    { model: 'test', effort: 'low' },
    { model: 'other-model', effort: null },
    { model: 'other-model' },
    undefined,
  ])('inherits native thread settings after a spawn override: %j', async (threadSettings) => {
    const { rpc } = await setup([{ id: 'message', text: 'hello' }], undefined, 'high');
    expect(rpc.request).toHaveBeenCalledWith('thread/start', expect.objectContaining({
      config: expect.objectContaining({ model_reasoning_effort: 'high' }),
    }));
    bridge.handle({ method: 'thread/settings/updated', params: { threadId: 'native', threadSettings } });
    await bridge.poll();
    expect(rpc.request).toHaveBeenLastCalledWith('turn/start', {
      threadId: 'native', input: [{ type: 'text', text: 'hello', text_elements: [] }],
    });
  });
});
