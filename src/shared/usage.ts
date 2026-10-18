import { harnessFor, isAgentKind, type NodeView, type Usage, type UsageSource } from './protocol.js';

export const usageToolName = (tool: string) => ({ claude: 'Claude Code', codex: 'Codex', pi: 'Pi' })[tool] ?? tool;
export const usageStale = (source: UsageSource, now: number) => source.at !== undefined && (source.availability === 'unavailable' || source.rateLimits.some((l) => (l.resetsAt && Date.parse(l.resetsAt) <= now) || (l.observedAt !== undefined && now - l.observedAt > 300_000)) || now - source.at > 5 * 60_000);

/** Only reports tied to this node; an unidentified account is never borrowed from another agent. */
export function selectedUsage(node: NodeView | undefined, sources: UsageSource[] | undefined, legacy?: Usage): UsageSource[] {
  if (!node || !isAgentKind(node.kind)) return [];
  const tool = harnessFor(node);
  const modelFamily = /^(?:claude-)?(opus|sonnet)(?:$|-|\[|\s)/i.exec(node.status.model ?? '')?.[1]?.toLowerCase();
  const reporterUnavailable = sources?.some((s) => s.id.startsWith('unavailable:') && s.tool === tool && s.nodeIds.includes(node.id));
  if (sources !== undefined) return sources.filter((s) => s.tool === tool && s.rateLimits.length > 0 && s.nodeIds.includes(node.id) &&
    (s.scope === 'account' || s.model === node.status.model)).map((source) => ({ ...source, availability: reporterUnavailable ? 'unavailable' : source.availability, rateLimits: source.rateLimits.filter((limit) => {
      const family = /^seven_day_(opus|sonnet)$/.exec(limit.kind)?.[1];
      return !family || modelFamily === family;
    }) })).filter((source) => source.rateLimits.length > 0);
  // Older daemons only have one Claude report: safe to show it solely on its reporting node.
  return tool === 'claude' && legacy?.nodeId === node.id ? [{
    ...legacy, id: 'legacy', tool: 'claude', scope: 'account', nodeIds: [node.id], installed: true,
    configured: true, authenticated: true, availability: 'available', checkedAt: legacy.at,
  }] : [];
}

export function usageScope(source: UsageSource): string {
  return source.scope === 'model' ? `model quota · ${source.model}` : 'shared account quota';
}

/** Overview-only groups of observations, never evidence that sessions share an account. */
export function groupUsageObservations(sources: UsageSource[]): { unidentified: boolean; reports: UsageSource[] }[] {
  const groups: { unidentified: boolean; reports: UsageSource[] }[] = [];
  const unidentified = new Map<string, typeof groups[number]>();
  for (const source of sources) {
    if (source.tool !== 'claude' || source.accountId) {
      groups.push({ unidentified: false, reports: [source] });
      continue;
    }
    const key = JSON.stringify([source.provider ?? '', source.poolId ?? source.pool ?? '', source.scope, source.model ?? '']);
    let group = unidentified.get(key);
    if (!group) {
      group = { unidentified: true, reports: [] };
      unidentified.set(key, group); groups.push(group);
    }
    group.reports.push(source);
  }
  for (const group of unidentified.values()) group.reports.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return groups;
}
