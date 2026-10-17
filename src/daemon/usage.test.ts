import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { discoverUsage, UsageRegistry, usageReportsSchema } from './usage.js';

it('discovers tools without live agents and treats config files as evidence, not authentication', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-usage-'));
  try {
    const bin = join(home, 'bin'); mkdirSync(bin); mkdirSync(join(home, '.codex'));
    writeFileSync(join(bin, 'codex'), ''); chmodSync(join(bin, 'codex'), 0o755);
    writeFileSync(join(home, '.codex', 'auth.json'), 'credentials must not be read');
    const sources = discoverUsage(bin, home, {}, 1);
    expect(sources.find((s) => s.tool === 'codex')).toMatchObject({ installed: true, configured: true, authenticated: null, availability: 'unknown', rateLimits: [] });
    expect(sources.find((s) => s.tool === 'claude')).toMatchObject({ installed: false, configured: null });
    expect(sources.find((s) => s.tool === 'pi')).toMatchObject({ availability: 'unavailable', rateLimits: [] });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it('retains independent unknown accounts, shares identified pools, and does not erase on empty readings', () => {
  const registry = new UsageRegistry('');
  registry.record('claude', 'a', [{ scope: 'account', rateLimits: [{ kind: '5h', percentUsed: 10 }] }], 100);
  registry.record('claude', 'b', [{ scope: 'account', rateLimits: [{ kind: '5h', percentUsed: 90 }] }], 200);
  registry.record('claude', 'a', [{ scope: 'account', rateLimits: [] }], 300);
  expect(registry.sources.filter((s) => s.at).map((s) => [s.nodeIds, s.rateLimits[0].percentUsed, s.at])).toEqual([[['a'], 10, 100], [['b'], 90, 200]]);
  const report = { accountId: 'acct', pool: 'shared', scope: 'account' as const, rateLimits: [{ kind: '7d', percentUsed: 20 }] };
  registry.record('codex', 'c', [report], 400); registry.record('codex', 'd', [report], 500);
  expect(registry.sources.find((s) => s.tool === 'codex' && s.at)).toMatchObject({ nodeIds: ['c', 'd'], at: 500 });
});

it('rejects malformed model scope and percentages at the report boundary', () => {
  expect(usageReportsSchema.safeParse([{ scope: 'model', rateLimits: [] }]).success).toBe(false);
  expect(usageReportsSchema.safeParse([{ scope: 'account', rateLimits: [{ kind: '5h', percentUsed: NaN }] }]).success).toBe(false);
});

it('keeps past-account snapshots in the overview but removes them from a node that switched accounts', () => {
  const registry = new UsageRegistry('');
  const report = { provider: 'openai', accountId: 'old', scope: 'account' as const, rateLimits: [{ kind: '5h', percentUsed: 90 }] };
  registry.record('codex', 'a', [report], 100);
  registry.record('codex', 'a', [{ ...report, accountId: 'new', rateLimits: [{ kind: '5h', percentUsed: 10 }] }], 200);
  expect(registry.sources.filter((s) => s.at).map((s) => [s.accountId, s.nodeIds])).toEqual([['old', []], ['new', ['a']]]);
});

it('keeps distinct metered pool IDs even when display names match', () => {
  const registry = new UsageRegistry('');
  const report = { accountId: 'acct', pool: 'Shared pool', scope: 'account' as const, rateLimits: [{ kind: '5h', percentUsed: 10 }] };
  registry.record('codex', 'a', [{ ...report, poolId: 'one' }, { ...report, poolId: 'two' }], 100);
  expect(registry.sources.filter((s) => s.at).map((s) => s.poolId)).toEqual(['one', 'two']);
});
