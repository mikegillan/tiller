import type { NodeView } from '../src/shared/protocol';

export const mk = (id: string, parentId: string | null, changedAt: number, extra: Partial<NodeView['status']> = {}): NodeView => ({
  id, parentId, kind: 'claude', title: id, cwd: '/w/' + id, createdAt: 0, unread: false,
  status: { state: 'working', changedAt, ...extra },
});
