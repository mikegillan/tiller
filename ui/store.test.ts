import { expect, it } from 'vitest';
import { mk } from './fixtures';
import { applyServer, diffRequested, expectSpawn, getState, update, transcriptRequested } from './store';

it('the diff panel shows the diff reply\'s own failure, not another error for the same node', () => {
  diffRequested('a');
  applyServer({ t: 'error', id: 'a', message: 'no such node: a' }); // say, a mute that failed
  expect(getState().diff).toEqual({ id: 'a' });
  applyServer({ t: 'diff', id: 'a', error: 'a has no worktree of its own to diff' });
  expect(getState().diff).toEqual({ id: 'a', error: 'a has no worktree of its own to diff' });
});

it('a transcript reply lands in the slot asked for and is ignored for another node or session', () => {
  const data = { entries: [{ role: 'user' as const, text: 'hi' }], sessions: [{ sessionId: 's2', current: true }, { sessionId: 's1', current: false }] };
  transcriptRequested('a');
  applyServer({ t: 'transcript', id: 'b', ...data });
  applyServer({ t: 'transcript', id: 'a', sessionId: 's1', ...data });
  expect(getState().transcript).toEqual({ id: 'a' });
  applyServer({ t: 'transcript', id: 'a', sessionId: 's2', ...data }); // the current session, named by the reply
  expect(getState().transcript).toEqual({ id: 'a', sessionId: undefined, data });

  transcriptRequested('a'); // a refresh keeps the old data until the reply
  expect(getState().transcript?.data).toEqual(data);
  transcriptRequested('a', 's1');
  expect(getState().transcript).toEqual({ id: 'a', sessionId: 's1' });
  applyServer({ t: 'transcript', id: 'a', ...data });
  expect(getState().transcript).toEqual({ id: 'a', sessionId: 's1' });
  applyServer({ t: 'transcript', id: 'a', sessionId: 's1', error: 'session file is gone' });
  expect(getState().transcript).toEqual({ id: 'a', sessionId: 's1', error: 'session file is gone' });
});

it('a history reply replaces the items', () => {
  const item = (id: string) => ({ id, rootId: 'r', parentId: null, title: id, cwd: '/w', createdAt: 0, closedAt: 1 });
  applyServer({ t: 'history', items: [item('x'), item('y')] });
  applyServer({ t: 'history', items: [item('z')] });
  expect(getState().history.map((a) => a.id)).toEqual(['z']);
});

it('a failed spawn stops the wait, so the next node someone else spawns is not selected', () => {
  applyServer({ t: 'snapshot', nodes: [mk('r', null, 1)] });
  expectSpawn();
  applyServer({ t: 'error', message: 'fork: no session on record' });
  applyServer({ t: 'node', node: mk('other', 'r', 2) });
  expect(getState().selected).toBe('r');
});

it('retains source reports through selection, removal and older snapshots, and accepts authoritative new snapshots', () => {
  const source = { id: 'source', tool: 'claude' as const, scope: 'account' as const, nodeIds: ['usage-a'], rateLimits: [{ kind: '5h', percentUsed: 30 }], at: 100, checkedAt: 100, installed: true, configured: true, authenticated: true, availability: 'available' as const };
  applyServer({ t: 'snapshot', nodes: [mk('usage-a', null, 1), mk('usage-b', null, 2)], usageSources: [source] });
  applyServer({ t: 'focus', from: 'human', id: 'usage-b' });
  applyServer({ t: 'removed', id: 'usage-a' });
  applyServer({ t: 'snapshot', nodes: [] });
  expect(getState().usageSources).toEqual([source]);
  applyServer({ t: 'usageSources', sources: [{ ...source, at: 200 }] });
  expect(getState().usageSources?.[0].at).toBe(200);
  applyServer({ t: 'snapshot', nodes: [], usageSources: [] });
  expect(getState().usageSources).toEqual([]);
});

it('a legacy-daemon refresh error clears the scanning state', () => {
  update(() => ({ usageScanning: true }));
  applyServer({ t: 'error', message: 'Malformed message' });
  expect(getState().usageScanning).toBe(false);
});
