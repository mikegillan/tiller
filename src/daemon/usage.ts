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

/** Filesystem evidence only: no credentials are read and no CLI or inference process is started. */
export function discoverUsage(path: string, home = homedir(), env = process.env, now = Date.now()): UsageSource[] {
  const dirs = path.split(delimiter).filter(Boolean).slice(0, 128);
  const configs: Record<UsageTool, string[]> = {
    claude: [join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json'), join(home, '.claude.json')],
    codex: [join(env.CODEX_HOME || join(home, '.codex'), 'config.toml'), join(env.CODEX_HOME || join(home, '.codex'), 'auth.json')],
    pi: [join(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), 'settings.json'), join(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), 'auth.json')],
  };
  return (['claude', 'codex', 'pi'] as const).map((tool) => {
    const installed = dirs.some((dir) => { try { const file = join(dir, tool); accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; } });
    const configured = configs[tool].some((file) => existsSync(file)) ? true : null;
    return { id: `discovery:${tool}`, tool, scope: 'account', nodeIds: [], installed, configured,
      authenticated: null, availability: tool === 'pi' ? 'unavailable' : 'unknown', rateLimits: [], checkedAt: now,
      detail: tool === 'pi' ? 'Pi does not report provider account quotas. Context and spend are separate.'
        : 'No quota report yet. Open this CLI in Tiller to receive supported account reports.',
    };
  });
}

/** Retained for the daemon lifetime, including after a reporting node exits or closes. */
export class UsageRegistry {
  private reports = new Map<string, UsageSource>();
  private discovery: UsageSource[] = [];
  private checkedAt?: number;
  private observed = new Set<UsageTool>();
  constructor(private path: string) { this.refresh(); }
  refresh(now = Date.now()): void {
    if (this.checkedAt !== undefined && now - this.checkedAt < 60_000) return;
    this.discovery = discoverUsage(this.path, undefined, undefined, now);
    this.checkedAt = now;
  }
  observe(tool: UsageTool): void { this.observed.add(tool); }
  get sources(): UsageSource[] {
    return [...this.discovery.map((s) => this.observed.has(s.tool) ? { ...s, installed: true, configured: true } : s), ...this.reports.values()];
  }
  record(tool: UsageTool, nodeId: string, reports: UsageReport[], now: number): void {
    this.observe(tool);
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
