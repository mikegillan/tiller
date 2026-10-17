import { beforeEach, expect, it, vi } from 'vitest';
import { mk } from './fixtures';
import { handleNotify } from './notify';
import { ACTIVITY_LIMIT, activityUnread, appendActivity, applyServer, clearActivity, getState, markActivityRead, recordActivity, selectNode, setActivityOpen, toast, update } from './store';

vi.mock('./url', () => ({ IN_APP: true, wantedNode: undefined }));
beforeEach(() => {
  update(() => ({ nodes: {}, activity: [], activityOpen: false, toasts: [], confirms: [] }));
});

it('a routine notification storm stays in a bounded feed without toasts or opening the drawer', () => {
  applyServer({ t: 'snapshot', nodes: [mk('agent', null, 0)] });
  for (let i = 0; i < 250; i++) handleNotify({ t: 'notify', id: 'agent', kind: i % 2 ? 'done' : 'exited', title: `Update ${i}` });
  expect(getState().toasts).toEqual([]);
  expect(getState().activityOpen).toBe(false);
  expect(getState().activity).toHaveLength(ACTIVITY_LIMIT);
  expect(getState().activity[0]).toMatchObject({ nodeName: 'agent', text: 'Update 249', tone: 'ok' });
  expect(getState().activity.at(-1)?.text).toBe('Update 50');
  expect(activityUnread(getState().activity)).toBe(200);
});

it('opening marks retained events read, new events remain unread, and read/clear are explicit', () => {
  recordActivity('Done', 'a', 'ok', 100);
  expect(activityUnread(getState().activity)).toBe(1);
  setActivityOpen(true);
  expect(activityUnread(getState().activity)).toBe(0);
  recordActivity('Next', 'b');
  expect(activityUnread(getState().activity)).toBe(1);
  markActivityRead();
  expect(activityUnread(getState().activity)).toBe(0);
  clearActivity();
  expect(getState().activity).toEqual([]);
  expect(getState().activityOpen).toBe(true);
});

it('retention does not mutate its input or count expired unread entries', () => {
  const original = Array.from({ length: 200 }, (_, id) => ({ id, nodeName: 'A', at: 0, text: 'old', tone: 'info' as const, read: id !== 199 }));
  const next = appendActivity(original, { id: 201, nodeName: 'B', at: 1, text: 'new', tone: 'info', read: true });
  expect(original).toHaveLength(200);
  expect(original.at(-1)?.read).toBe(false);
  expect(activityUnread(next)).toBe(0);
});

it('keeps needs-you and error feedback, manual action toasts and approval queue semantics', () => {
  handleNotify({ t: 'notify', id: 'a', kind: 'errored', title: 'Failed', body: 'Build failed' });
  handleNotify({ t: 'notify', id: 'b', kind: 'needsYou', title: 'Needs input' });
  applyServer({ t: 'confirm', confirmId: 'approval', text: 'Allow command?' });
  applyServer({ t: 'error', id: 'a', message: 'Action failed' });
  toast('Manual action completed', 'a', 'ok');
  expect(getState().activity.map((item) => item.text)).toEqual(['Action failed', 'Needs input', 'Failed: Build failed']);
  clearActivity();
  expect(getState().toasts.map((t) => t.text)).toEqual(['Failed: Build failed', 'Needs input', 'Action failed', 'Manual action completed']);
  expect(getState().confirms).toEqual([{ confirmId: 'approval', text: 'Allow command?' }]);
  expect(getState().activityOpen).toBe(false);
  applyServer({ t: 'confirmDone', confirmId: 'approval' });
  expect(getState().confirms).toEqual([]);
});

it('selection works for live nodes and closed events preserve their name without changing selection', () => {
  applyServer({ t: 'snapshot', nodes: [mk('a', null, 0), mk('b', null, 0)] });
  recordActivity('Done', 'a');
  selectNode('b');
  selectNode('a');
  expect(getState().selected).toBe('a');
  applyServer({ t: 'removed', id: 'a' });
  const selected = getState().selected;
  selectNode('a');
  expect(getState().selected).toBe(selected);
  expect(getState().activity[0].nodeName).toBe('a');
});
