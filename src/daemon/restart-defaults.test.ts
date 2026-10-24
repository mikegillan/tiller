import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NodeManager } from './manager.js';
import { PtySession, type SpawnOpts } from './pty.js';

// Config validation drops efforts a harness does not support, so only an override can make restart resolve one.
const override = vi.hoisted(() => ({ effort: undefined as string | undefined }));
vi.mock('./config.js', async (original) => {
  const m = await original<typeof import('./config.js')>();
  return { ...m, profileDefaults: (...a: Parameters<typeof m.profileDefaults>) => ({ ...m.profileDefaults(...a), ...(override.effort ? { effort: override.effort } : {}) }) };
});

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
  for (const h of ['claude', 'codex']) { writeFileSync(join(bin, h), '#!/bin/sh\n'); chmodSync(join(bin, h), 0o755); }
  processes = [];
  override.effort = undefined;
  vi.spyOn(PtySession, 'spawn').mockImplementation((opts) => {
    const s = new FakeSession(opts); processes.push(s); return s as unknown as PtySession;
  });
  manager = new NodeManager({ home: join(home, 'tl'), path: bin });
});
afterEach(async () => { await manager.shutdown(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });

const configure = (model: string, effort: string) =>
  writeFileSync(join(manager.home, 'config.json'), JSON.stringify({ profiles: { claude: { orchestrator: { model, effort } } } }));
const flag = (name: string) => { const args = processes.at(-1)!.opts.args; return args[args.indexOf(name) + 1]; };
const preset = (name: string, frontmatter: string) => {
  const agents = join(manager.home, 'agents'); mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, `${name}.md`), `---\n${frontmatter}\n---\nBody\n`);
};

it('restart re-resolves a defaulted model and effort from the current config', async () => {
  configure('claude-mythos-5-1', 'max');
  const { id } = await manager.spawn({ kind: 'claude', title: 'O', cwd: home, byHuman: true });
  expect(manager.registry.get(id)).toMatchObject({ model: 'claude-mythos-5-1', effort: 'max', explicit: [] });
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

it('restart keeps a field its preset set at spawn', async () => {
  configure('claude-mythos-5-1', 'max');
  preset('pinned', 'effort: low');
  const { id } = await manager.spawn({ kind: 'claude', title: 'O', cwd: home, preset: 'pinned', byHuman: true });
  expect(manager.registry.get(id)!.explicit).toEqual(['effort']);
  configure('claude-opus-5-5', 'high');
  expect(manager.restart(id)).toEqual({ ok: true });
  expect([flag('--model'), flag('--effort')]).toEqual(['claude-opus-5-5', 'low']);
});

it('restart re-resolves both on a legacy record without the marker', async () => {
  configure('claude-opus-5-5', 'high');
  const { id } = await manager.spawn({ kind: 'claude', title: 'O', cwd: home, model: 'claude-mythos-5-1', effort: 'max', byHuman: true });
  manager.registry.update(id, { explicit: undefined });
  expect(manager.restart(id)).toEqual({ ok: true });
  expect(manager.registry.get(id)).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
});

it('restart keeps what a legacy record\'s preset sets, and its stored values when the preset is gone', async () => {
  configure('claude-opus-5-5', 'high');
  preset('pinned', 'model: claude-haiku-5-5');
  const { id } = await manager.spawn({ kind: 'claude', title: 'O', cwd: home, preset: 'pinned', byHuman: true });
  manager.registry.update(id, { explicit: undefined, effort: 'max' });
  expect(manager.restart(id)).toEqual({ ok: true });
  expect(manager.registry.get(id)).toMatchObject({ model: 'claude-haiku-5-5', effort: 'high' });
  manager.registry.update(id, { preset: 'gone', model: 'claude-mythos-5-1', effort: 'max' });
  manager.restart(id); // the launch itself fails on the missing preset; the stored values stay
  expect(manager.registry.get(id)).toMatchObject({ model: 'claude-mythos-5-1', effort: 'max' });
});

it('a follow-up keeps the archived marker, and a harness change clears it', async () => {
  configure('claude-mythos-5-1', 'max');
  const { id } = await manager.spawn({ kind: 'claude', title: 'O', cwd: home, model: 'claude-sonnet-5-5', byHuman: true });
  const rec = manager.registry.get(id)!, transcript = join(home, 't.jsonl');
  writeFileSync(transcript, '');
  manager.applyHook(id, { hook_event_name: 'SessionStart', session_id: rec.sessionId, transcript_path: transcript });
  await manager.close(id, true);
  const f = await manager.followup(id, 'more');
  expect(manager.registry.get(f.id)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'max', explicit: ['model'] });
  expect(await manager.changeHarness(f.id, 'codex', undefined, true)).toEqual({ ok: true });
  expect(manager.registry.get(f.id)!.explicit).toEqual([]);
});

it('restart refuses an unsupported re-resolved effort and leaves the node as it was', async () => {
  const { id } = await manager.spawn({ kind: 'agent', harness: 'codex', title: 'C', cwd: home, byHuman: true });
  const before = { ...manager.registry.get(id)! }, process = processes.at(-1)!;
  override.effort = 'max';
  expect(manager.restart(id)).toEqual({ ok: false, error: 'unsupported codex effort: max' });
  expect(manager.registry.get(id)).toEqual(before);
  expect([processes.length, process.exited]).toEqual([1, false]);
});
