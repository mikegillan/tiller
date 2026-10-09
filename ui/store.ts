import { useSyncExternalStore } from 'react';
import type { NodeView, ServerMessage } from '../src/shared/protocol';
import { insertSorted } from './tree';

export interface Toast { id: number; text: string; nodeId?: string }
export interface Confirm { confirmId: string; text: string }
export interface State {
  nodes: Record<string, NodeView>;
  order: string[];
  selected: string | null;
  /** Nodes that have a mounted terminal. */
  opened: string[];
  collapsed: string[];
  toasts: Toast[];
  confirms: Confirm[];
  connected: boolean;
}

let state: State = { nodes: {}, order: [], selected: null, opened: [], collapsed: [], toasts: [], confirms: [], connected: false };
const subs = new Set<() => void>();
let toastSeq = 0;

export const getState = () => state;
export function update(fn: (s: State) => Partial<State>) {
  state = { ...state, ...fn(state) };
  subs.forEach((f) => f());
}
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => sel(state));
}

const without = <T,>(xs: T[], x: T) => xs.filter((y) => y !== x);

export const toast = (text: string, nodeId?: string) => update((s) => ({ toasts: [...s.toasts, { id: ++toastSeq, text, nodeId }] }));
export const dismissToast = (id: number) => update((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
export const dropConfirm = (confirmId: string) => update((s) => ({ confirms: s.confirms.filter((c) => c.confirmId !== confirmId) }));
export const setConnected = (connected: boolean) => update(() => ({ connected }));
export const toggleCollapsed = (id: string) =>
  update((s) => ({ collapsed: s.collapsed.includes(id) ? without(s.collapsed, id) : [...s.collapsed, id] }));

/** Select only; never reorders. Clears unread locally (the daemon also clears it on `select`). */
export function selectNode(id: string) {
  update((s) => {
    const n = s.nodes[id];
    if (!n) return {};
    return {
      selected: id,
      opened: s.opened.includes(id) ? s.opened : [...s.opened, id],
      nodes: n.unread ? { ...s.nodes, [id]: { ...n, unread: false } } : s.nodes,
    };
  });
}

/** Reducer for server messages that change state (data/notify are handled by conn.ts). */
export function applyServer(m: ServerMessage) {
  switch (m.t) {
    case 'snapshot':
      return update((s) => {
        const nodes = Object.fromEntries(m.nodes.map((n) => [n.id, n]));
        let order = s.order.filter((id) => nodes[id]);
        const fresh = m.nodes.filter((n) => !order.includes(n.id)).sort((a, b) => b.status.changedAt - a.status.changedAt);
        for (const n of fresh) order = insertSorted(order, nodes, n);
        const selected = s.selected && nodes[s.selected] ? s.selected : null;
        return { nodes, order, selected, opened: s.opened.filter((id) => nodes[id]) };
      });
    case 'node':
      return update((s) => {
        const known = s.order.includes(m.node.id);
        const nodes = { ...s.nodes, [m.node.id]: m.node };
        // The selected node is being looked at, so it never shows as unread.
        if (s.selected === m.node.id) nodes[m.node.id] = { ...m.node, unread: false };
        return { nodes, order: known ? s.order : insertSorted(s.order, s.nodes, m.node) };
      });
    case 'removed':
      return update((s) => {
        const { [m.id]: _gone, ...nodes } = s.nodes;
        return { nodes, order: without(s.order, m.id), opened: without(s.opened, m.id), selected: s.selected === m.id ? null : s.selected };
      });
    case 'confirm':
      return update((s) => ({ confirms: [...s.confirms, { confirmId: m.confirmId, text: m.text }] }));
    case 'confirmDone':
      return dropConfirm(m.confirmId);
    case 'error':
      return toast(m.message, m.id);
  }
}
