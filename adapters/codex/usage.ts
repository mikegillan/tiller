import type { RateLimit, UsageReport } from '../../src/shared/protocol.js';

export type CodexUsageMeasure = { usageReports?: UsageReport[]; usageUnavailable?: true };

/** One bounded read on an existing app-server connection. Failure never prevents a turn. */
export async function readCodexUsage(usage: CodexUsage, read: () => Promise<unknown>, timeoutMs = 2000): Promise<CodexUsageMeasure> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const payload = await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('account quota read timed out')), timeoutMs);
    })]);
    return usage.measure(payload);
  } catch { return { usageUnavailable: true }; }
  finally { clearTimeout(timer); }
}

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
  private mirrorId?: string;
  private pools = new Map<string, ObjectValue>();
  measure(payload: unknown): CodexUsageMeasure {
    const usageReports = this.reports(payload);
    return usageReports.length ? { usageReports } : { usageUnavailable: true };
  }
  reports(payload: unknown, now = Date.now()): UsageReport[] {
    const value = object(payload);
    if (!value) return [];
    const account = text(value.accountId);
    if (account && this.accountId && account !== this.accountId) { this.pools.clear(); this.mirrorId = undefined; }
    if (account) this.accountId = account;
    const fullRead = 'rateLimitsByLimitId' in value || 'accountId' in value;
    const mirror = text(object(value.rateLimits)?.limitId);
    if (mirror && fullRead) this.mirrorId = mirror;
    const buckets = object(value.rateLimitsByLimitId);
    const entries: [string, unknown][] = buckets && Object.keys(buckets).length ? Object.entries(buckets) : [['', value.rateLimits]];
    const changed: UsageReport[] = [];
    for (const [key, raw] of entries) {
      const bucket = object(raw);
      if (!bucket) continue;
      const id = text(bucket.limitId) ?? (key || this.mirrorId || (this.pools.size === 1 ? this.pools.keys().next().value : this.pools.size === 0 ? 'account' : undefined));
      if (!id) continue; // ambiguous metadata must not invent a second account pool
      const old = this.pools.get(id) ?? {};
      // Notifications are sparse: null windows and metadata do not erase a previous reading.
      const merged = { ...old, ...Object.fromEntries(Object.entries(bucket).filter(([, v]) => v != null)) };
      // Sparse notifications preserve null metadata; a full read can declare spend data unavailable.
      if ('individualLimit' in bucket && (bucket.individualLimit != null || fullRead)) merged.individualLimit = bucket.individualLimit;
      for (const name of ['primary', 'secondary', 'individualLimit']) {
        const fresh = object(bucket[name]);
        if (fresh) merged[name] = { ...object(old[name]), ...fresh, observedAt: now };
      }
      this.pools.set(id, merged);
      const limits: RateLimit[] = [];
      for (const name of ['primary', 'secondary']) {
        const window = object(merged[name]);
        if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent) || window.usedPercent < 0) continue;
        const mins = window.windowDurationMins;
        const duration = typeof mins === 'number' && Number.isFinite(mins) && mins > 0 ? (mins % 1440 === 0 ? `${mins / 1440}d` : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`) : name;
        limits.push({ kind: duration, windowId: name, percentUsed: window.usedPercent, resetsAt: reset(window.resetsAt), observedAt: window.observedAt as number });
      }
      const spend = object(merged.individualLimit);
      if (spend && typeof spend.remainingPercent === 'number' && Number.isFinite(spend.remainingPercent)) {
        limits.push({ kind: 'spend control', windowId: 'individualLimit', observedAt: spend.observedAt as number, percentUsed: Math.max(0, 100 - spend.remainingPercent), resetsAt: reset(spend.resetsAt) });
      }
      const removedWindows = fullRead && bucket.individualLimit === null ? [{ windowId: 'individualLimit', observedAt: now }] : [];
      if (limits.length || removedWindows.length) changed.push({ provider: 'openai', accountId: this.accountId, poolId: id, pool: text(merged.limitName) ?? id, scope: 'account', rateLimits: limits, ...(removedWindows.length ? { removedWindows } : {}) });
    }
    return changed;
  }
}
