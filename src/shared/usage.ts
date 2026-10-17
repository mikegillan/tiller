import { harnessFor, isAgentKind, type NodeView, type Usage, type UsageSource } from './protocol.js';

export const usageToolName = (tool: string) => ({ claude: 'Claude Code', codex: 'Codex', pi: 'Pi' })[tool] ?? tool;
export const usageStale = (source: UsageSource, now: number) => source.at !== undefined && now - source.at > 5 * 60_000;

/** Only reports tied to this node; an unidentified account is never borrowed from another agent. */
export function selectedUsage(node: NodeView | undefined, sources: UsageSource[] | undefined, legacy?: Usage): UsageSource[] {
  if (!node || !isAgentKind(node.kind)) return [];
  const tool = harnessFor(node);
  if (sources !== undefined) return sources.filter((s) => s.tool === tool && s.nodeIds.includes(node.id) &&
    (s.scope === 'account' || s.model === node.status.model));
  // Older daemons only have one Claude report: safe to show it solely on its reporting node.
  return tool === 'claude' && legacy?.nodeId === node.id ? [{
    ...legacy, id: 'legacy', tool: 'claude', scope: 'account', nodeIds: [node.id], installed: true,
    configured: true, authenticated: true, availability: 'available', checkedAt: legacy.at,
  }] : [];
}

export function usageScope(source: UsageSource): string {
  return source.scope === 'model' ? `model quota · ${source.model}` : 'shared account quota';
}
