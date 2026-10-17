import { expect, it } from 'vitest';
import { CodexUsage, readCodexUsage } from './usage.js';

it('normalizes all native pools and windows; quota aliases stay shared account quotas', () => {
  const usage = new CodexUsage();
  const reports = usage.reports({ accountId: 'a', rateLimitsByLimitId: {
    codex: { limitId: 'codex', limitName: 'Codex', normalModelSlug: 'gpt-6', primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 40, windowDurationMins: 10080 } },
    spark: { limitId: 'spark', primary: { usedPercent: 50, windowDurationMins: 60 } },
  } });
  expect(reports).toHaveLength(2);
  expect(reports[0]).toMatchObject({ accountId: 'a', scope: 'account', pool: 'Codex', rateLimits: [{ kind: '5h', percentUsed: 23, resetsAt: new Date(1800000000000).toISOString() }, { kind: '7d', percentUsed: 40 }] });
  expect(reports[0].model).toBeUndefined();
  const update = usage.reports({ rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 24, windowDurationMins: 300 }, secondary: null } });
  expect(update[0]).toMatchObject({ accountId: 'a', pool: 'Codex', rateLimits: [{ percentUsed: 24 }, { percentUsed: 40 }] });
});

it('handles legacy single bucket, invalid windows, and an account switch without borrowing prior windows', () => {
  const usage = new CodexUsage();
  expect(usage.reports({ rateLimits: { primary: { usedPercent: 'wrong' } } })).toEqual([]);
  expect(usage.reports({ accountId: 'a', rateLimits: { primary: { usedPercent: 1, resetsAt: 1e100 } } })[0].rateLimits).toMatchObject([{ kind: 'primary', percentUsed: 1, resetsAt: undefined }]);
  expect(usage.reports({ accountId: 'b', rateLimits: { secondary: { usedPercent: 2 } } })[0]).toMatchObject({ accountId: 'b', rateLimits: [{ kind: 'secondary', percentUsed: 2 }] });
});

it('labels spend control separately and honors explicit unavailable spend data', () => {
  const usage = new CodexUsage();
  expect(usage.reports({ rateLimits: { limitId: 'codex', primary: { usedPercent: 10 }, individualLimit: { remainingPercent: 25, resetsAt: 1800000000 } } })[0].rateLimits).toMatchObject([{ kind: 'primary', percentUsed: 10 }, { kind: 'spend control', percentUsed: 75 }]);
  expect(usage.reports({ rateLimits: { limitId: 'codex', individualLimit: null } })[0].rateLimits).toHaveLength(2);
  expect(usage.reports({ accountId: 'a', rateLimits: { limitId: 'codex', individualLimit: null } })[0].rateLimits).toMatchObject([{ kind: 'primary', percentUsed: 10, resetsAt: undefined }]);
});

it('preserves unrelated pools through sparse updates and isolates account identity changes', () => {
  const usage = new CodexUsage();
  usage.measure({ accountId: 'old', rateLimitsByLimitId: {
    codex: { limitId: 'codex', primary: { usedPercent: 10 }, secondary: { usedPercent: 20 } },
    spark: { limitId: 'spark', primary: { usedPercent: 80 } },
  } });
  expect(usage.measure({ rateLimits: { limitId: 'codex', primary: { usedPercent: 11 }, secondary: null } }).usageReports?.[0]).toMatchObject({ accountId: 'old', rateLimits: [{ percentUsed: 11 }, { percentUsed: 20 }] });
  expect(usage.measure({ rateLimits: { limitId: 'spark', primary: null } }).usageReports?.[0]).toMatchObject({ accountId: 'old', rateLimits: [{ percentUsed: 80 }] });
  expect(usage.measure({ accountId: 'new', rateLimits: { limitId: 'codex', primary: { usedPercent: 1 } } }).usageReports?.[0]).toMatchObject({ accountId: 'new', rateLimits: [{ percentUsed: 1 }] });
  expect(usage.measure({ rateLimits: { limitId: 'spark', primary: null } })).toEqual({ usageUnavailable: true });
});


it('reports unavailable APIs and bounds initial reads without fabricating quota percentages', async () => {
  const usage = new CodexUsage();
  expect(usage.measure({})).toEqual({ usageUnavailable: true });
  expect(usage.measure({ rateLimits: { credits: { balance: '100', hasCredits: true } } })).toEqual({ usageUnavailable: true });
  expect(await readCodexUsage(usage, async () => { throw new Error('not available for API key'); })).toEqual({ usageUnavailable: true });
  const start = Date.now();
  expect(await readCodexUsage(usage, () => new Promise(() => {}), 10)).toEqual({ usageUnavailable: true });
  expect(Date.now() - start).toBeLessThan(1000);
  expect(await readCodexUsage(usage, async () => ({ accountId: 'a', rateLimits: { primary: { usedPercent: 3 } } }))).toMatchObject({ usageReports: [{ accountId: 'a', scope: 'account', rateLimits: [{ percentUsed: 3 }] }] });
});

it('merges nullable IDs into the known mirror pool and retains original per-window freshness', () => {
  const usage = new CodexUsage();
  usage.reports({ accountId: 'a', rateLimits: { limitId: 'codex' }, rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 10 }, secondary: { usedPercent: 40 }, individualLimit: { remainingPercent: 50 } },
    spark: { primary: { usedPercent: 70 } },
  } }, 100);
  const report = usage.reports({ rateLimits: { limitId: null, primary: { usedPercent: 11 }, secondary: null, individualLimit: null } }, 300)[0];
  expect(report).toMatchObject({ poolId: 'codex', accountId: 'a', scope: 'account', rateLimits: [
    { percentUsed: 11, observedAt: 300 }, { percentUsed: 40, observedAt: 100 }, { percentUsed: 50, observedAt: 100 },
  ] });
  expect(usage.reports({ rateLimits: { limitId: 'spark', primary: null } }, 400)[0].rateLimits[0]).toMatchObject({ percentUsed: 70, observedAt: 100 });
});

it('emits a timestamped spend-window tombstone only for an explicit full-read null', () => {
  const usage = new CodexUsage();
  usage.reports({ accountId: 'a', rateLimits: { limitId: 'codex', individualLimit: { remainingPercent: 25 } } }, 100);
  const sparse = usage.reports({ rateLimits: { limitId: 'codex', individualLimit: null } }, 200)[0];
  expect(sparse.rateLimits).toMatchObject([{ windowId: 'individualLimit', percentUsed: 75, observedAt: 100 }]);
  expect(sparse.removedWindows).toBeUndefined();
  expect(usage.reports({ accountId: 'a', rateLimits: { limitId: 'codex', individualLimit: null } }, 300)[0]).toMatchObject({
    rateLimits: [], removedWindows: [{ windowId: 'individualLimit', observedAt: 300 }],
  });
});
