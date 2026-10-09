import { expect, test } from 'vitest';
import type { NodeView } from './protocol.js';
import { pruneIds } from './prune.js';

const n = (id: string, parentId: string | null, exited: boolean): NodeView =>
  ({ id, parentId, title: id, kind: 'claude', cwd: '/', createdAt: 0, unread: false, status: { state: 'done', changedAt: 0, exited } });

test('prunes exited nodes, keeps live ones and exited ancestors of a live node', () => {
  const nodes = [n('root', null, true), n('live', 'root', false), n('deadkid', 'root', true), n('gone', null, true), n('goneKid', 'gone', true), n('run', null, false)];
  expect(pruneIds(nodes).sort()).toEqual(['deadkid', 'gone', 'goneKid']);
});
