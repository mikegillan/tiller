import { expect, it } from 'vitest';
import { CodexUsage } from './usage.js';

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
  expect(usage.reports({ accountId: 'a', rateLimits: { primary: { usedPercent: 1, resetsAt: 1e100 } } })[0].rateLimits).toEqual([{ kind: 'primary', percentUsed: 1, resetsAt: undefined }]);
  expect(usage.reports({ accountId: 'b', rateLimits: { secondary: { usedPercent: 2 } } })[0]).toMatchObject({ accountId: 'b', rateLimits: [{ kind: 'secondary', percentUsed: 2 }] });
});

it('labels spend control separately and honors explicit unavailable spend data', () => {
  const usage = new CodexUsage();
  expect(usage.reports({ rateLimits: { limitId: 'codex', primary: { usedPercent: 10 }, individualLimit: { remainingPercent: 25, resetsAt: 1800000000 } } })[0].rateLimits).toMatchObject([{ kind: 'primary', percentUsed: 10 }, { kind: 'spend control', percentUsed: 75 }]);
  expect(usage.reports({ rateLimits: { limitId: 'codex', individualLimit: null } })[0].rateLimits).toEqual([{ kind: 'primary', percentUsed: 10, resetsAt: undefined }]);
});
