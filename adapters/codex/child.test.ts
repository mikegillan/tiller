import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ManagedChild } from './child.js';

let child: EventEmitter & { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kill: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.useFakeTimers();
  child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, kill: vi.fn(() => true) });
});
afterEach(() => { vi.useRealTimers(); });
const observe = () => new ManagedChild(child as unknown as ChildProcess);

it('waits for actual graceful exit, not the successful return from kill', async () => {
  const process = observe();
  let done = false;
  const stopped = process.terminate().then((value) => { done = true; return value; });
  await vi.advanceTimersByTimeAsync(249);
  expect(done).toBe(false);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  child.emit('exit', 0);
  expect(await stopped).toBe(true);
  expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
});

it('escalates after the grace period and still requires exit confirmation', async () => {
  const process = observe();
  const stopped = process.terminate();
  expect(process.terminate()).toBe(stopped);
  await vi.advanceTimersByTimeAsync(250);
  expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
  let done = false;
  void stopped.then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(999);
  expect(done).toBe(false);
  child.emit('exit', null, 'SIGKILL');
  expect(await stopped).toBe(true);
});

it.each(['no event', 'signal error'] as const)('fails closed when exit is unproven: %s', async (failure) => {
  if (failure === 'signal error') child.kill.mockImplementation(() => { throw new Error('EPERM'); });
  const process = observe();
  const stopped = process.terminate();
  child.emit('close'); // Closed stdio alone is not process exit.
  await vi.advanceTimersByTimeAsync(1250);
  expect(await stopped).toBe(false);
  let exited = false;
  void process.exit.then(() => { exited = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(exited).toBe(false);
  child.emit('exit', 0);
  await process.exit;
  expect(exited).toBe(true);
});

it('does not signal an already exited process and treats failed spawn as no child', async () => {
  child.exitCode = 0;
  expect(await observe().terminate()).toBe(true);
  expect(child.kill).not.toHaveBeenCalled();
  child.exitCode = null; child.pid = undefined;
  const failed = observe();
  child.emit('error', new Error('ENOENT'));
  expect(await failed.terminate()).toBe(true);
  expect(child.kill).not.toHaveBeenCalled();
});
