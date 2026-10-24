import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeManager, type SpawnRequest } from './manager.js';
import { PtySession } from './pty.js';

describe('NodeManager.spawn refusal precedence', () => {
  let home: string;
  let m: NodeManager;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tl-spawn-policy-'));
    m = new NodeManager({ home, shell: '/bin/sh' });
    vi.spyOn(PtySession, 'spawn').mockImplementation(() => ({ exited: true, kill() {}, onData() {}, onExit() {} } as unknown as PtySession));
  });
  afterEach(async () => { await m.shutdown(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });

  it('reports the first refusal when a request breaks several rules, peeling them off in order', async () => {
    const parent = await m.spawn({ kind: 'claude', title: 'parent', cwd: home, byHuman: true, permissionMode: 'plan' });
    const before = m.list().length;
    const spawn = (extra: Partial<SpawnRequest>) => m.spawn({ kind: 'agent', title: 'child', cwd: home, parentId: parent.id, ...extra });
    let req: Partial<SpawnRequest> = { kind: 'terminal', harness: 'codex', preset: 'missing', isolation: 'worktree', base: 'b' };
    m.runtimes.get(parent.id)!.busy = 'changing harness';
    await expect(spawn(req)).rejects.toThrow('parent is changing harness');
    m.runtimes.get(parent.id)!.busy = undefined;
    const steps: [Partial<SpawnRequest>, string][] = [
      [{}, 'terminal nodes cannot select a harness'],
      [{ harness: undefined }, 'a preset is for agent nodes only'],
      [{ preset: undefined }, 'isolation "worktree" is for agent nodes only'],
      [{ isolation: undefined }, 'base is for isolation "worktree" only'],
      [{ kind: 'claude', harness: 'codex' }, 'use kind "agent" for a non-Claude harness'],
      [{ kind: 'agent', preset: 'missing', effort: 'max', account: 'x', permissionMode: 'bypassPermissions' }, 'no preset "missing"'],
      [{ preset: undefined }, 'unsupported Codex effort: max'],
      [{ effort: undefined }, 'refused: only the human may choose a Claude account'],
      [{ account: undefined }, 'refused: only the human or an unrestricted agent parent may spawn Codex'],
    ];
    for (const [change, error] of steps) {
      req = { ...req, ...change };
      await expect(spawn(req)).rejects.toThrow(error);
    }
    m.applyHook(parent.id, { hook_event_name: 'UserPromptSubmit', permission_mode: 'bypassPermissions' });
    await expect(spawn(req)).rejects.toThrow('refused: only the human may spawn a node with permissionMode bypassPermissions');
    await expect(spawn({ ...req, permissionMode: 'plan' })).rejects.toThrow('Codex does not support Claude permissionMode');
    await expect(spawn({ ...req, permissionMode: undefined })).rejects.toThrow('base is for isolation "worktree" only');
    expect(m.list()).toHaveLength(before);
  });
});
