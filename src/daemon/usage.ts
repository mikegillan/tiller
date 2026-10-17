import { execFile } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { z } from 'zod';
import type { UsageReport, UsageSource, UsageTool } from '../shared/protocol.js';

export const rateLimitsSchema = z.array(z.object({ kind: z.string().min(1).max(128), percentUsed: z.number().finite().min(0), resetsAt: z.string().max(64).optional() })).max(32);
export const usageReportsSchema = z.array(z.object({
  provider: z.string().min(1).max(128).optional(), accountId: z.string().min(1).max(256).optional(),
  pool: z.string().min(1).max(128).optional(), poolId: z.string().min(1).max(128).optional(), model: z.string().min(1).max(128).optional(),
  scope: z.enum(['account', 'model']), rateLimits: rateLimitsSchema,
}).refine((r) => r.scope !== 'model' || !!r.model)).max(32);

/** Match executable resolution in the daemon's launch PATH, without invoking a shell. */
function executable(tool: UsageTool, path: string): string | undefined {
  for (const dir of path.split(delimiter)) {
    try { const file = join(dir || '.', tool); accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file; } catch { /* try the next PATH entry */ }
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
  record(tool: UsageTool, nodeId: string, reports: UsageReport[], now: number): void {
    for (const report of reports) {
      if (!report.rateLimits.length) continue; // unavailable reading does not erase a useful snapshot
      // Unknown accounts remain isolated by node; never assume two CLI sessions share credentials.
      const id = JSON.stringify([tool, report.provider ?? '', report.accountId ?? `node:${nodeId}`, report.poolId ?? report.pool ?? '', report.scope, report.scope === 'model' ? report.model ?? '' : '']);
      // A node that changes accounts must stop selecting its former account's quotas.
      for (const [key, previous] of this.reports) {
        if (previous.tool === tool && previous.provider === report.provider && previous.accountId !== report.accountId && previous.nodeIds.includes(nodeId)) {
          this.reports.set(key, { ...previous, nodeIds: previous.nodeIds.filter((id) => id !== nodeId) });
        }
      }
      const old = this.reports.get(id);
      this.reports.set(id, { ...report, id, tool, nodeIds: [...new Set([...(old?.nodeIds ?? []), nodeId])],
        installed: true, configured: true, authenticated: true, availability: 'available', at: now, checkedAt: now });
    }
  }
}
