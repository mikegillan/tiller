import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TillerClient, type InboxMessage } from '../pi/client.js';
import { CodexBridge } from './bridge.js';
import { RpcError } from './rpc.js';

let dir: string, bridge: CodexBridge;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tl-codex-bridge-')); });
afterEach(async () => { await bridge?.stop(); rmSync(dir, { recursive: true, force: true }); });

async function setup(messages: InboxMessage[], resumeHistory?: string) {
  const client = new TillerClient({ endpoint: 'http://unused', nodeId: 'n-1', token: 'node-token' });
  vi.spyOn(client, 'hook').mockResolvedValue();
  vi.spyOn(client, 'modEvent').mockResolvedValue();
  vi.spyOn(client, 'inbox').mockResolvedValue(messages);
  vi.spyOn(client, 'claim').mockResolvedValue(true);
  vi.spyOn(client, 'ack').mockResolvedValue();
  vi.spyOn(client, 'release').mockResolvedValue(true);
  vi.spyOn(client, 'unconfirmed').mockResolvedValue();
  const rpc = { send: vi.fn(), request: vi.fn(async (method: string) => {
    if (method === 'thread/resume') throw new RpcError('no rollout found for thread id old');
    return method.startsWith('thread/') ? { thread: { id: 'native' }, model: 'test' } : { turn: { id: 'turn' } };
  }) };
  const fatal = vi.fn();
  if (resumeHistory !== undefined) writeFileSync(join(dir, 'session.jsonl'), JSON.stringify({ type: 'codex_session', threadId: 'old' }) + '\n' + resumeHistory);
  bridge = new CodexBridge({ transcriptPath: join(dir, 'session.jsonl'), sessionId: 'tiller-id', resume: resumeHistory !== undefined, instructions: 'role' }, rpc, client, vi.fn(), fatal);
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
