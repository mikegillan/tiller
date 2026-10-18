import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexRpc } from './rpc.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: ReturnType<typeof vi.fn> };
let rpc: CodexRpc;
beforeEach(() => {
  child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as any);
  rpc = new CodexRpc({}, vi.fn());
});
afterEach(() => {
  rpc.close(); child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); vi.useRealTimers();
});
const finalPacket = { method: 'item/completed', params: { item: { type: 'agentMessage', text: 'buffered final answer' } } };

describe('Codex RPC shutdown', () => {
  it('processes final stdout after process exit before reporting server closure', async () => {
    const seen: string[] = [];
    rpc.onPacket = () => { seen.push('answer'); };
    rpc.onClose = () => { seen.push('closed'); };
    child.emit('exit', 0);
    child.stdout.write(JSON.stringify(finalPacket) + '\n');
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0);
    await expect.poll(() => seen).toEqual(['answer', 'closed']);
    expect(seen).toEqual(['answer', 'closed']);
  });

  it('rejects a pending request with the actual exit error while draining its final packet', async () => {
    const seen: string[] = [];
    rpc.onPacket = () => { seen.push('answer'); };
    rpc.onClose = (error) => { seen.push(error.message); };
    const pending = rpc.request('thread/start', {}).catch((error) => error.message);
    child.emit('exit', 23);
    child.stdout.write(JSON.stringify(finalPacket) + '\n');
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 23);
    expect(await pending).toBe('Codex app-server exited (23)');
    await expect.poll(() => seen).toEqual(['answer', 'Codex app-server exited (23)']);
  });

  it('waits for stdout EOF and native exit on deliberate shutdown and rejects pending requests', async () => {
    const packets: unknown[] = [];
    rpc.onPacket = (packet) => { packets.push(packet); };
    const pending = rpc.request('turn/start', {}).catch((error) => error.message);
    const stopped = rpc.shutdown();
    child.stdout.write(JSON.stringify(finalPacket) + '\n');
    child.stdout.end();
    child.emit('exit', 0);
    child.stderr.end();
    child.emit('close', 0);
    await stopped;
    expect(packets).toEqual([finalPacket]);
    expect(await pending).toBe('Codex connection closed');
  });

  it('cuts off native stdout at 250ms but waits for post-escalation exit', async () => {
    vi.useFakeTimers();
    let done = false;
    const shutdown = rpc.shutdown();
    expect(rpc.shutdown()).toBe(shutdown);
    const stopped = shutdown.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(249);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(child.stdout.destroyed).toBe(true);
    expect(done).toBe(false);
    child.emit('exit', null, 'SIGKILL');
    await stopped;
    expect(done).toBe(true);
  });

  it('rejects shutdown when even escalated app-server exit cannot be confirmed', async () => {
    vi.useFakeTimers();
    const stopped = rpc.shutdown().catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(1250);
    expect(await stopped).toContain('exit was not confirmed');
    child.emit('exit', null, 'SIGKILL');
    await rpc.processExit;
  });
});
