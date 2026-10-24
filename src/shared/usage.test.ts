import { expect, it } from 'vitest';
import type { NodeView, UsageSource } from './protocol.js';
import { groupUsageObservations, selectedUsage, usageStale } from './usage.js';
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

it('groups unidentified Claude observations for display without merging their readings or asserting an account', () => {
  const reports = [43, 38, 44].map((percentUsed, i) => ({ ...source, id: `session-${i}`, nodeIds: [`session-${i}`], at: [200, 100, 300][i], rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt: '2026-10-17T14:00:00Z' }, { kind: 'seven_day', percentUsed: 9 }] }));
  const groups = groupUsageObservations(reports);
  expect(groups).toHaveLength(1);
  expect(groups[0].unidentified).toBe(true);
  expect(groups[0].reports.map((r) => r.rateLimits[0].percentUsed)).toEqual([44, 43, 38]);
  expect(groups[0].reports[0]).toBe(reports[2]);
  expect(reports.map((r) => r.id)).toEqual(['session-0', 'session-1', 'session-2']);
});

it('keeps known accounts, tools, providers, pools and model scopes distinct in the overview', () => {
  const reports = [source, { ...source, accountId: 'a' }, { ...source, accountId: 'b' },
    { ...source, tool: 'codex' as const }, { ...source, tool: 'codex' as const },
    { ...source, provider: 'gateway' }, { ...source, poolId: 'one', pool: 'Same name' }, { ...source, poolId: 'two', pool: 'Same name' },
    { ...source, pool: 'Named pool' }, { ...source, scope: 'model' as const, model: 'opus' }, { ...source, scope: 'model' as const, model: 'sonnet' }];
  expect(groupUsageObservations(reports)).toHaveLength(reports.length);
});

it('preserves per-window observation times, unavailable snapshots and sparse readings in unidentified groups', () => {
  const older: UsageSource = { ...source, at: 100, availability: 'unavailable', rateLimits: [{ kind: '5h', percentUsed: 43, observedAt: 100 }, { kind: '7d', percentUsed: 9, observedAt: 90 }] };
  const latest: UsageSource = { ...source, id: 'new', at: 300, rateLimits: [{ kind: '5h', percentUsed: 44, observedAt: 300 }] };
  const [group] = groupUsageObservations([older, latest]);
  expect(group.reports).toEqual([latest, older]);
  expect(group.reports[0].rateLimits).toHaveLength(1); // never borrow another unidentified session's weekly window
  expect(group.reports[1].availability).toBe('unavailable');
  expect(group.reports[1].rateLimits[1].observedAt).toBe(90);
});

it('keeps input order for equally fresh observations without dropping any reports', () => {
  const first = { ...source, id: 'first', at: 300 };
  const second = { ...source, id: 'second', at: 300 };
  const older = { ...source, id: 'older', at: 100 };
  expect(groupUsageObservations([older, first, second])[0].reports).toEqual([first, second, older]);
});

it('keeps group identity when the newest reporting session changes and distinguishes pool ID from display name', () => {
  const first = { ...source, id: 'first', at: 100 };
  const second = { ...source, id: 'second', at: 200 };
  const [before] = groupUsageObservations([first, second]);
  const [after] = groupUsageObservations([{ ...first, at: 300 }, second]);
  expect(before.reports[0].id).toBe('second');
  expect(after.reports[0].id).toBe('first');
  expect(after.id).toBe(before.id);
  const pools = groupUsageObservations([{ ...first, poolId: 'shared' }, { ...second, pool: 'shared' }]);
  expect(pools).toHaveLength(2);
  expect(pools[0].id).not.toBe(pools[1].id);
});

it('a node in a Tiller Claude account sees that account\'s quota, never another account\'s or an unaccounted node\'s', () => {
  const work: UsageSource = { ...source, id: 'account:work', account: 'work', nodeIds: ['b'] };
  const inWork = { ...node('a'), account: 'work' };
  expect(selectedUsage(inWork, [work])).toEqual([work]);
  expect(selectedUsage({ ...node('a'), account: 'personal' }, [work])).toEqual([]);
  expect(selectedUsage(node('a'), [work])).toEqual([]);
  expect(selectedUsage({ ...node('a'), account: 'work' }, [{ ...source, nodeIds: ['b'] }])).toEqual([]);
});

it('groups Claude reports by Tiller account apart from unidentified per-node readings', () => {
  const groups = groupUsageObservations([source, { ...source, id: 'account:work', account: 'work' }, { ...source, id: 'account:home', account: 'home' }, { ...source, id: 'b' }]);
  expect(groups.map((g) => [g.unidentified, g.reports.map((r) => r.id)])).toEqual([[true, ['a', 'b']], [false, ['account:work']], [false, ['account:home']]]);
});
