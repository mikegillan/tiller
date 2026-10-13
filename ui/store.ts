import { useSyncExternalStore } from 'react';
import type { ServerMessage } from '../src/shared/protocol';
import { pickInitial, rootOf } from './sessions';
import { insertSorted, type Nodes } from './tree';
import { wantedNode } from './url';

export type Tone = 'info' | 'ok' | 'warn' | 'bad';
export interface Toast { id: number; text: string; nodeId?: string; tone: Tone }
export interface Confirm { confirmId: string; text: string }
export type Dialog =
  | { kind: 'spawn'; parentId: string | null; cwd: string }
  | { kind: 'kill'; id: string }
  | { kind: 'restart'; id: string }
  | { kind: 'palette' };

export interface State {
  nodes: Nodes;
  order: string[];
  selected: string | null;
  /** Root of the selected node's tree: the session shown in the sidebar. */
  session: string | null;
  /** Nodes that have a mounted terminal. */
  opened: string[];
  collapsed: string[];
  toasts: Toast[];
  confirms: Confirm[];
  connected: boolean;
  /** Reconnect attempts since the last successful connection. */
  retry: number;
  panel: boolean;
  dialog: Dialog | null;
  /** Node whose title is being edited inline. */
  renaming: string | null;
  /** A spawn was requested: select the next new node that arrives. */
  awaitSpawn: boolean;
}

const stored = (() => { try { return localStorage.getItem('o8.panel') === '1'; } catch { return false; } })();

let state: State = {
  nodes: {}, order: [], selected: null, session: null, opened: [], collapsed: [], toasts: [], confirms: [],
  connected: false, retry: 0, panel: stored, dialog: null, renaming: null, awaitSpawn: false,
};
const subs = new Set<() => void>();
let toastSeq = 0;

export const getState = () => state;
export function update(fn: (s: State) => Partial<State>) {
  state = { ...state, ...fn(state) };
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

const without = <T,>(xs: T[], x: T) => xs.filter((y) => y !== x);

export const toast = (text: string, nodeId?: string, tone: Tone = 'info') =>
  update((s) => ({ toasts: [...s.toasts, { id: ++toastSeq, text, nodeId, tone }] }));
export const dismissToast = (id: number) => update((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
export const dropConfirm = (confirmId: string) => update((s) => ({ confirms: s.confirms.filter((c) => c.confirmId !== confirmId) }));
export const setConnected = (connected: boolean, retry = 0) => update(() => ({ connected, retry }));
export const openDialog = (dialog: Dialog | null) => update(() => ({ dialog }));
export const setRenaming = (renaming: string | null) => update(() => ({ renaming }));
export const expectSpawn = () => update(() => ({ awaitSpawn: true }));
export const toggleCollapsed = (id: string) =>
  update((s) => ({ collapsed: s.collapsed.includes(id) ? without(s.collapsed, id) : [...s.collapsed, id] }));
export const togglePanel = () => update((s) => {
  try { localStorage.setItem('o8.panel', s.panel ? '0' : '1'); } catch { /* per-viewer convenience only */ }
  return { panel: !s.panel };
});

/** Selection patch: selects `id` (and so its session), mounts its terminal, and clears unread locally (the daemon clears it on `select`). */
function choose(s: State, nodes: Nodes, id: string | null): Partial<State> {
  const n = id ? nodes[id] : undefined;
  if (!id || !n) return { nodes, selected: null, session: null };
  return {
    nodes: n.unread ? { ...nodes, [id]: { ...n, unread: false } } : nodes,
    selected: id,
    session: rootOf(nodes, id),
    opened: s.opened.includes(id) ? s.opened : [...s.opened, id],
  };
}

export const selectNode = (id: string) => update((s) => (s.nodes[id] ? choose(s, s.nodes, id) : {}));

/** Switching session selects its root. */
export const selectSession = (rootId: string) => update((s) => (s.session === rootId ? {} : choose(s, s.nodes, rootId)));

/** Reducer for server messages that change state (data/notify are handled by conn.ts). */
export function applyServer(m: ServerMessage) {
  switch (m.t) {
    case 'snapshot':
      return update((s) => {
        const nodes = Object.fromEntries(m.nodes.map((n) => [n.id, n]));
        let order = s.order.filter((id) => nodes[id]);
        const fresh = m.nodes.filter((n) => !order.includes(n.id)).sort((a, b) => b.status.changedAt - a.status.changedAt);
        for (const n of fresh) order = insertSorted(order, nodes, n);
        const base = { ...s, order, opened: s.opened.filter((id) => nodes[id]) };
        const sel = s.selected && nodes[s.selected] ? s.selected : pickInitial(nodes, order, s.selected ? undefined : wantedNode);
        return { order, opened: base.opened, ...choose(base, nodes, sel) };
      });
    case 'node':
      return update((s) => {
        const isNew = !s.order.includes(m.node.id);
        const nodes = { ...s.nodes, [m.node.id]: m.node };
        const order = isNew ? insertSorted(s.order, s.nodes, m.node) : s.order;
        // The selected node is being looked at, so it never shows as unread.
        if (s.selected === m.node.id) nodes[m.node.id] = { ...m.node, unread: false };
        if (isNew && s.awaitSpawn) return { order, awaitSpawn: false, ...choose(s, nodes, m.node.id) };
        return { nodes, order };
      });
    case 'removed':
      return update((s) => {
        const { [m.id]: gone, ...nodes } = s.nodes;
        const order = without(s.order, m.id);
        const base = { ...s, opened: without(s.opened, m.id) };
        const next = s.selected !== m.id ? s.selected : gone?.parentId && nodes[gone.parentId] ? gone.parentId : pickInitial(nodes, order);
        return { order, opened: base.opened, ...choose(base, nodes, next) };
      });
    case 'focus':
      return update((s) => ((m.from === 'human' || s.selected === m.from) && s.nodes[m.id] ? choose(s, s.nodes, m.id) : {}));
    case 'confirm':
      return update((s) => ({ confirms: [...s.confirms, { confirmId: m.confirmId, text: m.text }] }));
    case 'confirmDone':
      return dropConfirm(m.confirmId);
    case 'error':
      return toast(m.message, m.id, 'bad');
  }
}
