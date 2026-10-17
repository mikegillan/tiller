import { execFile } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { z } from 'zod';
import type { UsageReport, UsageSource, UsageTool } from '../shared/protocol.js';

export const rateLimitsSchema = z.array(z.object({ kind: z.string().min(1).max(128), percentUsed: z.number().finite().min(0), resetsAt: z.string().max(64).optional(), windowId: z.string().min(1).max(128).optional(), observedAt: z.number().finite().nonnegative().optional() })).max(32);
export const usageReportsSchema = z.array(z.object({
  provider: z.string().min(1).max(128).optional(), accountId: z.string().min(1).max(256).optional(),
  pool: z.string().min(1).max(128).optional(), poolId: z.string().min(1).max(128).optional(), model: z.string().min(1).max(128).optional(),
  scope: z.enum(['account', 'model']), rateLimits: rateLimitsSchema,
}).refine((r) => r.scope !== 'model' || !!r.model)).max(32);

/** Match executable resolution in the daemon's launch PATH, without invoking a shell. */
function executable(tool: UsageTool, path: string): string | undefined {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    try { const file = join(dir, tool); accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file; } catch { /* try the next PATH entry */ }
  }
}

/** Filesystem evidence only; config-file presence does not establish authentication. */
export function discoverUsage(path: string, home = homedir(), env = process.env, now = Date.now()): UsageSource[] {
  const configs: Record<UsageTool, string[]> = {
    claude: [join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json'), join(home, '.claude.json')],
    codex: [join(env.CODEX_HOME || join(home, '.codex'), 'config.toml'), join(env.CODEX_HOME || join(home, '.codex'), 'auth.json')],
    pi: [join(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), 'settings.json'), join(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), 'auth.json')],
  };
  return (['claude', 'codex', 'pi'] as const).map((tool) => {
    const installed = !!executable(tool, path);
    const configured = configs[tool].some((file) => existsSync(file)) ? true : null;
    return { id: `discovery:${tool}`, tool, scope: 'account', nodeIds: [], installed, configured, executableStatus: installed ? 'unknown' : undefined,
      authenticated: null, availability: tool === 'pi' ? 'unavailable' : 'unknown', rateLimits: [], checkedAt: now,
      detail: tool === 'pi' ? 'Pi does not report provider account quotas. Context and spend are separate.'
        : 'No quota report yet. Open this CLI in Tiller to receive supported account reports.',
    };
  });
}

/** Three bounded read-only version probes; never starts an interactive or inference session. */
async function probeVersions(sources: UsageSource[], path: string): Promise<UsageSource[]> {
  return Promise.all(sources.map(async (source) => {
    const file = source.installed ? executable(source.tool, path) : undefined;
    if (!file) return source;
    return new Promise<UsageSource>((resolve) => {
      execFile(file, ['--version'], { env: { ...process.env, PATH: path }, timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 16_384 }, (error, stdout, stderr) => {
        const version = stripVTControlCharacters(stdout || stderr).trim().split('\n')[0]?.slice(0, 160);
        resolve({ ...source, executableStatus: error || !version ? 'broken' : 'ready', version: error ? undefined : version || undefined });
      });
    });
  }));
}

/** Retained for the daemon lifetime, including after a reporting node exits or closes. */
export class UsageRegistry {
  private reports = new Map<string, UsageSource>();
  private discovery: UsageSource[] = [];
  private windowTimes = new Map<string, Map<string, number>>();
  private probedAt?: number;
  private scanning?: Promise<void>;
  constructor(private path: string) { this.discovery = discoverUsage(path); }
  /** Coalesce concurrent viewers and cap subprocess discovery to one scan per minute. */
  refresh(now = Date.now()): Promise<void> {
    if (this.scanning) return this.scanning;
    if (this.probedAt !== undefined && now - this.probedAt < 60_000) return Promise.resolve();
    this.probedAt = now;
    this.scanning = probeVersions(discoverUsage(this.path, undefined, undefined, now), this.path)
      .then((sources) => { this.discovery = sources; })
      .finally(() => { this.scanning = undefined; });
    return this.scanning;
  }
  get sources(): UsageSource[] {
    return [...this.discovery, ...this.reports.values()];
  }
  /** Keep one newest unidentified closed report per tool, without combining unknown accounts. */
  remove(nodeId: string): boolean {
    let changed = false;
    for (const [id, source] of this.reports) {
      if (!source.nodeIds.includes(nodeId)) continue;
      changed = true;
      if (id.startsWith('unavailable:')) this.reports.delete(id);
      else this.reports.set(id, { ...source, nodeIds: source.nodeIds.filter((id) => id !== nodeId) });
    }
    for (const tool of ['claude', 'codex', 'pi'] as const) {
      const closed = [...this.reports.values()].filter((s) => s.tool === tool && !s.accountId && !s.nodeIds.length)
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
      for (const source of closed.slice(1)) { this.reports.delete(source.id); this.windowTimes.delete(source.id); changed = true; }
    }
    return changed;
  }
  unavailable(tool: UsageTool, nodeId: string, now: number): boolean {
    let changed = false;
    for (const [id, source] of this.reports) {
      if (source.tool === tool && source.nodeIds.includes(nodeId) && source.availability !== 'unavailable') {
        this.reports.set(id, { ...source, availability: 'unavailable' }); changed = true;
      }
    }
    const id = `unavailable:${tool}:${nodeId}`;
    if (!this.reports.has(id)) {
      this.reports.set(id, { id, tool, scope: 'account', nodeIds: [nodeId], installed: null, configured: null, authenticated: null,
        availability: 'unavailable', detail: 'Account quota is currently unavailable from this CLI. Any retained readings may be stale.', rateLimits: [], checkedAt: now });
      changed = true;
    }
    return changed;
  }
  record(tool: UsageTool, nodeId: string, reports: UsageReport[], now: number): boolean {
    let changed = false;
    for (const report of reports) {
      if (!report.rateLimits.length) continue;
      // Unknown accounts remain isolated by node; never assume two CLI sessions share credentials.
      const id = JSON.stringify([tool, report.provider ?? '', report.accountId ?? `node:${nodeId}`, report.poolId ?? report.pool ?? '', report.scope, report.scope === 'model' ? report.model ?? '' : '']);
      for (const [key, previous] of this.reports) {
        if (previous.tool === tool && previous.provider === report.provider && previous.accountId !== report.accountId && previous.nodeIds.includes(nodeId)) {
          this.reports.set(key, { ...previous, nodeIds: previous.nodeIds.filter((id) => id !== nodeId) }); changed = true;
        }
      }
      const old = this.reports.get(id);
      const limits = new Map((old?.rateLimits ?? []).map((limit) => [limit.windowId ?? limit.kind, limit]));
      const times = this.windowTimes.get(id) ?? new Map<string, number>();
      let accepted = false;
      for (const limit of report.rateLimits) {
        const key = limit.windowId ?? limit.kind, at = Math.min(limit.observedAt ?? now, now);
        if (at < (times.get(key) ?? -1)) continue;
        limits.set(key, limit.observedAt === undefined ? limit : { ...limit, observedAt: at }); times.set(key, at); accepted = true;
      }
      if (!accepted) {
        if (old && !old.nodeIds.includes(nodeId)) { this.reports.set(id, { ...old, nodeIds: [...old.nodeIds, nodeId] }); changed = true; }
        continue;
      }
      if (this.reports.delete(`unavailable:${tool}:${nodeId}`)) changed = true;
      this.windowTimes.set(id, times);
      const at = Math.max(...times.values());
      const source: UsageSource = { ...report, rateLimits: [...limits.values()], id, tool, nodeIds: [...new Set([...(old?.nodeIds ?? []), nodeId])],
        installed: true, configured: true, authenticated: true, availability: 'available', at, checkedAt: at };
      if (JSON.stringify(source) !== JSON.stringify(old)) { this.reports.set(id, source); changed = true; }
    }
    return changed;
  }
}
