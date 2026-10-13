import { expect, it } from 'vitest';
import { applyServer, diffRequested, getState } from './store';

it('the diff panel shows the diff reply\'s own failure, not another error for the same node', () => {
  diffRequested('a');
  applyServer({ t: 'error', id: 'a', message: 'no such node: a' }); // say, a mute that failed
  expect(getState().diff).toEqual({ id: 'a' });
  applyServer({ t: 'diff', id: 'a', error: 'a has no worktree of its own to diff' });
  expect(getState().diff).toEqual({ id: 'a', error: 'a has no worktree of its own to diff' });
});
