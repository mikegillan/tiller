import { useSyncExternalStore } from 'react';
import type { ArchivedNode, Diff, DigestItem, Dnd, ServerMessage, Transcript, Usage, UsageSource } from '../src/shared/protocol';
import type { ReviewComment } from './diff';
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
  | { kind: 'followup'; id: string; title: string }
  /** Spawn a Claude node that starts from `from`'s conversation (a live or archived node). */
  | { kind: 'fork'; from: string; title: string; cwd: string; parentId: string | null }
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
  /** Do not disturb, as the daemon last reported it. */
  dnd?: Dnd;
  /** Account-level rate limits, as the newest node report gave them. */
  usage?: Usage;
  usageSources?: UsageSource[];
  usageScanning?: boolean;
  /** What happened while no client was focused, until dismissed. */
  digest?: { since: number; items: DigestItem[] };
  /** The Diff tab is showing instead of the terminal (for worktree nodes). */
  diffOpen: boolean;
  /** The last diff asked for; data stays while a refresh is out, so the view does not flicker. */
  diff: { id: string; data?: Diff; error?: string } | null;
  /** Review comments not sent yet, for any node. */
  comments: ReviewComment[];
  /** The Transcript tab is showing instead of the terminal (for Claude nodes). */
  transcriptOpen: boolean;
  /** The last transcript asked for (no sessionId: the node's current session); data stays while a refresh is out. */
  transcript: { id: string; sessionId?: string; data?: Transcript; error?: string } | null;
  /** The sidebar shows closed nodes instead of the tree. */
  historyOpen: boolean;
  /** The last history reply. */
  history: ArchivedNode[];
  /** The closed node shown in the main pane, over the selected live node. */
  archived: ArchivedNode | null;
  /** Counts `removed` messages, so an open history asks again when a node is closed. */
  removals: number;
}

const stored = (() => { try { return localStorage.getItem('tl.panel') === '1'; } catch { return false; } })();

let state: State = {
  nodes: {}, order: [], selected: null, session: null, opened: [], collapsed: [], toasts: [], confirms: [],
  connected: false, retry: 0, panel: stored, dialog: null, renaming: null, awaitSpawn: false, diffOpen: false, diff: null, comments: [],
  transcriptOpen: false, transcript: null, historyOpen: false, history: [], archived: null, removals: 0,
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
export const setConnected = (connected: boolean, retry = 0) => update(() => ({ connected, retry, ...(!connected ? { usageScanning: false } : {}) }));
export const openDialog = (dialog: Dialog | null) => update(() => ({ dialog }));
export const dismissDigest = () => update(() => ({ digest: undefined }));
export const setRenaming = (renaming: string | null) => update(() => ({ renaming }));
export const expectSpawn = () => update(() => ({ awaitSpawn: true }));
export const toggleCollapsed = (id: string) =>
  update((s) => ({ collapsed: s.collapsed.includes(id) ? without(s.collapsed, id) : [...s.collapsed, id] }));
export const togglePanel = () => update((s) => {
  try { localStorage.setItem('tl.panel', s.panel ? '0' : '1'); } catch { /* per-viewer convenience only */ }
  return { panel: !s.panel };
});

/** What the stage shows for a live node. */
export const showPane = (pane: 'terminal' | 'diff' | 'transcript') => update(() => ({ diffOpen: pane === 'diff', transcriptOpen: pane === 'transcript' }));
/** Note that a diff for `id` was asked for; conn.ts sends the request. */
export const diffRequested = (id: string) => update((s) => ({ diff: s.diff?.id === id ? s.diff : { id } }));
/** Note that a transcript for `id` (and `sessionId`, else the current one) was asked for; the caller sends the request. */
export const transcriptRequested = (id: string, sessionId?: string) =>
  update((s) => ({ transcript: s.transcript?.id === id && s.transcript.sessionId === sessionId ? s.transcript : { id, sessionId } }));
export const toggleHistory = () => update((s) => ({ historyOpen: !s.historyOpen }));
export const viewArchived = (archived: ArchivedNode | null) => update(() => ({ archived }));
export const addComment = (c: ReviewComment) => update((s) => ({ comments: [...s.comments, c] }));
export const removeComment = (c: ReviewComment) => update((s) => ({ comments: without(s.comments, c) }));
export const clearComments = (nodeId: string) => update((s) => ({ comments: s.comments.filter((c) => c.nodeId !== nodeId) }));

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

export const selectNode = (id: string) => update((s) => (s.nodes[id] ? { archived: null, ...choose(s, s.nodes, id) } : {}));

/** Switching session selects its root. */
export const selectSession = (rootId: string) => update((s) => (s.session === rootId ? {} : { archived: null, ...choose(s, s.nodes, rootId) }));

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
        return { order, opened: base.opened, usage: m.usage ?? s.usage, usageSources: m.usageSources ?? s.usageSources, dnd: m.dnd, ...choose(base, nodes, sel) };
      });
    case 'dnd':
      return update(() => ({ dnd: { on: m.on, until: m.until } }));
    case 'usageSources':
      return update(() => ({ usageSources: m.sources, usageScanning: false }));
    case 'usage':
      return update(() => ({ usage: m.usage }));
    case 'node':
      return update((s) => {
        const isNew = !s.order.includes(m.node.id);
        const nodes = { ...s.nodes, [m.node.id]: m.node };
        const order = isNew ? insertSorted(s.order, s.nodes, m.node) : s.order;
        // The selected node is being looked at, so it never shows as unread.
        if (s.selected === m.node.id) nodes[m.node.id] = { ...m.node, unread: false };
        if (isNew && s.awaitSpawn) return { order, awaitSpawn: false, archived: null, ...choose(s, nodes, m.node.id) };
        return { nodes, order };
      });
    case 'removed':
      return update((s) => {
        const { [m.id]: gone, ...nodes } = s.nodes;
        const order = without(s.order, m.id);
        const base = { ...s, opened: without(s.opened, m.id) };
        const next = s.selected !== m.id ? s.selected : gone?.parentId && nodes[gone.parentId] ? gone.parentId : pickInitial(nodes, order);
        return { order, opened: base.opened, removals: s.removals + 1, ...choose(base, nodes, next) };
      });
    case 'focus':
      return update((s) => ((m.from === 'human' || s.selected === m.from) && s.nodes[m.id] ? choose(s, s.nodes, m.id) : {}));
    case 'confirm':
      return update((s) => ({ confirms: [...s.confirms, { confirmId: m.confirmId, text: m.text }] }));
    case 'confirmDone':
      return dropConfirm(m.confirmId);
    case 'diff': {
      const { t: _, id, ...data } = m;
      return update((s) => (s.diff?.id === id ? { diff: 'error' in data ? { id, error: data.error } : { id, data } } : {}));
    }
    case 'transcript': {
      const { t: _, id, sessionId, ...data } = m;
      return update((s) => {
        const want = s.transcript;
        // A request without a session is answered for the current one, whether or not the reply names it.
        const current = 'sessions' in data ? data.sessions.find((x) => x.current)?.sessionId : undefined;
        if (want?.id !== id || (want.sessionId !== sessionId && !(want.sessionId === undefined && sessionId === current))) return {};
        return { transcript: 'error' in data ? { id, sessionId: want.sessionId, error: data.error } : { id, sessionId: want.sessionId, data } };
      });
    }
    case 'history':
      return update(() => ({ history: m.items }));
    case 'sent': {
      const title = state.nodes[m.id]?.title ?? m.id;
      const { outcome, detail } = m.result;
      if (outcome !== 'delivered' && outcome !== 'queued') return toast(`Not sent to ${title}: ${outcome}${detail ? ` (${detail})` : ''}`, m.id, 'bad');
      clearComments(m.id);
      return toast(outcome === 'queued' ? `Queued for ${title}; it arrives when the node is idle` : `Sent to ${title}`, m.id, 'ok');
    }
    case 'error':
      // A spawn or follow-up that failed answers only with an error: stop waiting, or the next node anyone spawns gets selected.
      if (state.awaitSpawn) update(() => ({ awaitSpawn: false }));
      return toast(m.message, m.id, 'bad');
    case 'digest':
      return update(() => ({ digest: { since: m.since, items: m.items } }));
  }
}
