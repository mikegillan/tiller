import type { NodeView } from '../src/shared/protocol';
import { needsYou, statusKind } from './tree';

/** The app's menu bar item: red if a node errored, amber if one needs you, else green; and the nodes that need you, as [id, title]. */
export function trayState(nodes: NodeView[]): { color: 'green' | 'amber' | 'red'; items: [string, string][] } {
  const needs = nodes.filter(needsYou);
  const color = nodes.some((n) => statusKind(n) === 'errored') ? 'red' : needs.length ? 'amber' : 'green';
  return { color, items: needs.map((n) => [n.id, n.title]) };
}
