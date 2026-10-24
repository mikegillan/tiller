import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeManager } from './manager.js';
import * as wt from './worktree.js';
import { refreshGit } from './worktree-lifecycle.js';

vi.mock('./worktree.js', () => ({ branchExists: vi.fn(async () => false), dirtyFiles: vi.fn() }));

/** Each dirtyFiles call waits until the test resolves it with the files it should see. */
const pending: ((files: string[]) => void)[] = [];
vi.mocked(wt.dirtyFiles).mockImplementation(() => new Promise((r) => pending.push(r)));
const settle = () => new Promise((r) => setTimeout(r, 0));

function fakeManager() {
  const worktree = { repo: process.cwd(), path: process.cwd(), branch: 'tl/x', base: 'dev', baseSha: '' };
  const m = {
    stopped: false,
    registry: { get: () => ({ id: 'x', worktree }) },
    runtimes: new Map<string, { git?: { dirty: number } }>([['x', {}]]),
    emitNode: vi.fn(),
  };
  return { m, nm: m as unknown as NodeManager };
}

describe('refreshGit coalescing', () => {
  afterEach(() => { pending.length = 0; vi.mocked(wt.dirtyFiles).mockClear(); });

  it('runs git once for a burst of calls, then once more for those made during the run, seeing the later tree', async () => {
    const { m, nm } = fakeManager();
    const first = refreshGit(nm, 'x');
    const second = refreshGit(nm, 'x'), third = refreshGit(nm, 'x');
    expect(second).toBe(third);
    await settle();
    expect(wt.dirtyFiles).toHaveBeenCalledTimes(1);
    pending.shift()!(['a']);
    await first;
    expect(m.runtimes.get('x')!.git!.dirty).toBe(1);
    await settle();
    expect(wt.dirtyFiles).toHaveBeenCalledTimes(2);
    pending.shift()!(['a', 'b']); // the change made while the first run was in flight
    await second;
    expect(m.runtimes.get('x')!.git!.dirty).toBe(2);
    expect(m.emitNode).toHaveBeenCalledTimes(2);
    await settle();
    expect(wt.dirtyFiles).toHaveBeenCalledTimes(2);
    // Idle again: the next call starts its own run, which emits nothing when the state is unchanged.
    const fourth = refreshGit(nm, 'x');
    await settle();
    pending.shift()!(['a', 'b']);
    await fourth;
    expect(wt.dirtyFiles).toHaveBeenCalledTimes(3);
    expect(m.emitNode).toHaveBeenCalledTimes(2);
  });

  it('skips the queued rerun once the node is closed', async () => {
    const { m, nm } = fakeManager();
    const first = refreshGit(nm, 'x'), second = refreshGit(nm, 'x');
    await settle();
    m.runtimes.delete('x');
    pending.shift()!(['a']);
    await Promise.all([first, second]);
    await settle();
    expect(wt.dirtyFiles).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(0);
    expect(m.emitNode).not.toHaveBeenCalled();
  });
});
