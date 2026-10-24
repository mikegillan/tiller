import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NodeManager } from './manager.js';
import { PtySession, type SpawnOpts } from './pty.js';

class FakeSession {
  exited = false;
  private exits: Array<(code: number) => void> = [];
  constructor(readonly opts: SpawnOpts) {}
  onData() {}
  onExit(cb: (code: number) => void) { this.exits.push(cb); }
  async flush() {}
  screenTail() { return []; }
  async write() {}
  classifyScreen() { return 'unknown' as const; }
  kill() { this.exited = true; for (const cb of this.exits) cb(0); }
  async terminate() { this.kill(); return true; }
}

let home: string, manager: NodeManager, processes: FakeSession[];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tl-restart-defaults-'));
  const bin = join(home, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n'); chmodSync(join(bin, 'claude'), 0o755);
  processes = [];
  vi.spyOn(PtySession, 'spawn').mockImplementation((opts) => {
    const s = new FakeSession(opts); processes.push(s); return s as unknown as PtySession;
  });
  manager = new NodeManager({ home: join(home, 'tl'), path: bin });
});
afterEach(async () => { await manager.shutdown(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });

const configure = (model: string, effort: string) =>
  writeFileSync(join(manager.home, 'config.json'), JSON.stringify({ profiles: { claude: { orchestrator: { model, effort } } } }));
const flag = (name: string) => { const args = processes.at(-1)!.opts.args; return args[args.indexOf(name) + 1]; };

it('restart re-resolves a defaulted model and effort from the current config', async () => {
  configure('claude-mythos-5-1', 'max');
  const { id } = await manager.spawn({ kind: 'claude', title: 'O', cwd: home, byHuman: true });
  expect(manager.registry.get(id)).toMatchObject({ model: 'claude-mythos-5-1', effort: 'max' });
  configure('claude-opus-5-5', 'high');
  expect(manager.restart(id)).toEqual({ ok: true });
  expect(manager.registry.get(id)).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
  expect([flag('--model'), flag('--effort')]).toEqual(['claude-opus-5-5', 'high']);
});

it('restart keeps an explicit model while its defaulted effort follows the config', async () => {
  configure('claude-mythos-5-1', 'max');
  const { id } = await manager.spawn({ kind: 'claude', title: 'O', cwd: home, model: 'claude-sonnet-5-5', byHuman: true });
  configure('claude-opus-5-5', 'high');
  expect(manager.restart(id)).toEqual({ ok: true });
  expect(manager.registry.get(id)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high', explicit: ['model'] });
});

it('restart re-resolves both on a legacy record without the marker', async () => {
  configure('claude-opus-5-5', 'high');
  const { id } = await manager.spawn({ kind: 'claude', title: 'O', cwd: home, model: 'claude-mythos-5-1', effort: 'max', byHuman: true });
  manager.registry.update(id, { explicit: undefined });
  expect(manager.restart(id)).toEqual({ ok: true });
  expect(manager.registry.get(id)).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
});
