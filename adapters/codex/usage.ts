import type { RateLimit, UsageReport } from '../../src/shared/protocol.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value.slice(0, 128) : undefined;
const reset = (value: unknown): string | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  const date = new Date(value * 1000); // Codex reports Unix seconds, not milliseconds.
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

/** Native app-server account/rateLimits/read and account/rateLimits/updated payloads.
 * Never interpret normalModelSlug (a quota alias) as proof of a model-exclusive pool.
 * Keep this instance for the bridge lifetime: rolling notifications omit account metadata.
 */
export class CodexUsage {
  private accountId?: string;
  private pools = new Map<string, ObjectValue>();
  reports(payload: unknown): UsageReport[] {
    const value = object(payload);
    if (!value) return [];
    const account = text(value.accountId);
    if (account && this.accountId && account !== this.accountId) this.pools.clear();
    if (account) this.accountId = account;
    const buckets = object(value.rateLimitsByLimitId);
    const entries: [string, unknown][] = buckets && Object.keys(buckets).length ? Object.entries(buckets) : [['', value.rateLimits]];
    const changed: UsageReport[] = [];
    for (const [key, raw] of entries) {
      const bucket = object(raw);
      if (!bucket) continue;
      const id = text(bucket.limitId) ?? (key || 'account');
      const old = this.pools.get(id) ?? {};
      // Notifications are sparse: null windows and metadata do not erase a previous reading.
      const merged = { ...old, ...Object.fromEntries(Object.entries(bucket).filter(([, v]) => v != null)) };
      // Spend-control null explicitly means unavailable, unlike sparse quota windows.
      if ('individualLimit' in bucket) merged.individualLimit = bucket.individualLimit;
      this.pools.set(id, merged);
      const limits: RateLimit[] = [];
      for (const name of ['primary', 'secondary']) {
        const window = object(merged[name]);
        if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent) || window.usedPercent < 0) continue;
        const mins = window.windowDurationMins;
        const duration = typeof mins === 'number' && Number.isFinite(mins) && mins > 0 ? (mins % 1440 === 0 ? `${mins / 1440}d` : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`) : name;
        limits.push({ kind: duration, percentUsed: window.usedPercent, resetsAt: reset(window.resetsAt) });
      }
      const spend = object(merged.individualLimit);
      if (spend && typeof spend.remainingPercent === 'number' && Number.isFinite(spend.remainingPercent)) {
        limits.push({ kind: 'spend control', percentUsed: Math.max(0, 100 - spend.remainingPercent), resetsAt: reset(spend.resetsAt) });
      }
      if (limits.length) changed.push({ provider: 'openai', accountId: this.accountId, poolId: id, pool: text(merged.limitName) ?? id, scope: 'account', rateLimits: limits });
    }
    return changed;
  }
}
