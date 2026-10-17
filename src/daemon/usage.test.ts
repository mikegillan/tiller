import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

it('probes versions without sessions, labels broken executables, bounds hangs and caches concurrent scans', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-usage-probe-'));
  try {
    const marker = join(home, 'calls');
    const scripts = {
      claude: `#!${process.execPath}\nconst fs = require('node:fs'); if (process.argv[2] !== '--version') throw Error('only version allowed'); fs.appendFileSync(${JSON.stringify(marker)}, 'version\\n'); console.log('Claude Code test-version');`,
      codex: '#!/missing-tiller-test-interpreter\n',
      pi: `#!${process.execPath}\nif (process.argv[2] !== '--version') throw Error('only version allowed'); setInterval(() => {}, 10000);`,
    };
    for (const [tool, script] of Object.entries(scripts)) { writeFileSync(join(home, tool), script); chmodSync(join(home, tool), 0o755); }
    const registry = new UsageRegistry(home); // independent of any nodes or configured accounts
    expect(registry.sources.every((s) => s.installed && s.authenticated === null && s.rateLimits.length === 0)).toBe(true);
    const started = Date.now();
    await Promise.all([registry.refresh(100000), registry.refresh(100000)]);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(registry.sources.find((s) => s.tool === 'claude')).toMatchObject({ version: 'Claude Code test-version', executableStatus: 'ready', authenticated: null });
    expect(registry.sources.filter((s) => s.tool !== 'claude').map((s) => s.executableStatus)).toEqual(['broken', 'broken']);
    await registry.refresh(100001);
    expect(readFileSync(marker, 'utf8')).toBe('version\n');
    registry.record('codex', 'old-agent', [{ scope: 'account', rateLimits: [{ kind: '5h', percentUsed: 40 }] }], 100000);
    rmSync(join(home, 'codex'));
    await registry.refresh(160001);
    expect(registry.sources.find((s) => s.id === 'discovery:codex')).toMatchObject({ installed: false });
    expect(registry.sources.find((s) => s.at)?.rateLimits[0].percentUsed).toBe(40);
    expect(readFileSync(marker, 'utf8')).toBe('version\nversion\n');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
