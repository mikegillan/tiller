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

it('expired windows are stale and model-family windows do not leak to another Claude model', () => {
  expect(usageStale({ ...source, at: 1000, rateLimits: [{ kind: '5h', percentUsed: 80, resetsAt: new Date(2000).toISOString() }] }, 3000)).toBe(true);
  const modelPools = { ...source, rateLimits: [...source.rateLimits, { kind: 'seven_day_opus', percentUsed: 30 }, { kind: 'seven_day_sonnet', percentUsed: 40 }] };
  expect(selectedUsage(node('a', 'claude', 'claude-opus-5-5'), [modelPools])[0].rateLimits.map((l) => l.kind)).toEqual(['5h', 'seven_day_opus']);
});

it('scopes shared-account read failures to the selected reporter', () => {
  const shared = { ...source, accountId: 'shared', nodeIds: ['a', 'b'] };
  const failure: UsageSource = { ...source, id: 'unavailable:claude:a', rateLimits: [], at: undefined, availability: 'unavailable' };
  expect(selectedUsage(node('a'), [shared, failure])[0].availability).toBe('unavailable');
  expect(selectedUsage(node('b'), [shared, failure])[0].availability).toBe('available');
});

it('matches model-family aliases with context suffixes and version variants', () => {
  const pools = { ...source, rateLimits: [{ kind: 'seven_day_opus', percentUsed: 10 }, { kind: 'seven_day_sonnet', percentUsed: 20 }] };
  for (const model of ['opus', 'opus[1m]', 'Opus[1M]', 'opus-5-5', 'claude-opus-5-5[1m]']) {
    expect(selectedUsage(node('a', 'claude', model), [pools])[0].rateLimits.map((l) => l.kind)).toEqual(['seven_day_opus']);
  }
  for (const model of ['sonnet', 'sonnet[1m]', 'sonnet-5-5', 'claude-sonnet-5-5[1m]']) {
    expect(selectedUsage(node('a', 'claude', model), [pools])[0].rateLimits.map((l) => l.kind)).toEqual(['seven_day_sonnet']);
  }
});
