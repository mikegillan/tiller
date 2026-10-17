import { expect, it } from 'vitest';
import type { NodeView, UsageSource } from './protocol.js';
import { selectedUsage, usageStale } from './usage.js';
const node = (id: string, kind: NodeView['kind'] = 'claude', model = 'opus'): NodeView => ({ id, kind, parentId: null, title: id, cwd: '/', createdAt: 0, unread: false, status: { state: 'done', changedAt: 0, model } });
const source: UsageSource = { id: 'a', tool: 'claude', nodeIds: ['a'], scope: 'account', rateLimits: [{ kind: '5h', percentUsed: 10 }], installed: true, configured: true, authenticated: true, availability: 'available', at: 100, checkedAt: 100 };
it('selected-agent quota never leaks to a different agent, terminal, or empty selection', () => {
  expect(selectedUsage(node('a'), [source])).toEqual([source]);
  expect(selectedUsage(node('b'), [source])).toEqual([]);
  expect(selectedUsage(node('a', 'terminal'), [source])).toEqual([]);
  expect(selectedUsage(undefined, [source])).toEqual([]);
  expect(selectedUsage(node('a', 'agent'), [{ ...source, tool: 'pi' }])).toEqual([]);
  expect(selectedUsage(node('a'), [{ ...source, scope: 'model', model: 'sonnet' }])).toEqual([]);
  expect(usageStale(source, 400000)).toBe(true);
});
it('legacy reports remain available only on the reporting Claude agent', () => {
  const legacy = { nodeId: 'a', at: 100, rateLimits: source.rateLimits };
  expect(selectedUsage(node('a'), undefined, legacy)).toHaveLength(1);
  expect(selectedUsage(node('b'), undefined, legacy)).toEqual([]);
  expect(selectedUsage(node('a'), [], legacy)).toEqual([]);
});
