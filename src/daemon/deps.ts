// Dependency launches (spawn after / afterSuccess), the daemon.maxWorking queue, and notify_when: when a set of nodes
// counts as finished, and holding a node back until then.
import { outcomeLine } from '../shared/format.js';
import type { AgentState, Isolation, NodeView, Pending } from '../shared/protocol.js';
import { loadConfig } from './config.js';
import type { NodeManager, NodeRuntime, SpawnRequest } from './manager.js';
import { DAEMON, deliver } from './messaging.js';
import { initialState } from './status.js';
import { logError } from './util.js';
import { addWorktree } from './worktree-lifecycle.js';

type Mgr = Pick<NodeManager, 'view' | 'turnStartedAt'>;

/** Whether `id` has finished a turn begun at or after `since`, has exited, or is gone. */
export function turnDone(m: Mgr, id: string, since: number): boolean {
  const v = m.view(id);
  return !v || !!v.status.exited || (v.status.state === 'done' && (m.turnStartedAt(id) ?? -Infinity) >= since);
}

const succeeded = (v: NodeView | undefined) => v?.outcome?.outcome === 'succeeded' && v.outcome.gate !== 'failed';

/** Where a pending node's dependencies stand: every one now met, and the first failed afterSuccess one as "n-x: <outcome line>". */
export function checkDeps(m: Mgr, p: Pending, since: number): { met: string[]; unmet: string[]; blocked?: string } {
  const met = new Set(p.met);
  for (const id of p.after) if (turnDone(m, id, since)) met.add(id);
  for (const id of p.afterSuccess) if (succeeded(m.view(id))) met.add(id);
  const unmet = [...new Set([...p.after, ...p.afterSuccess])].filter((id) => !met.has(id));
  let blocked: string | undefined;
  for (const id of p.afterSuccess.filter((x) => !met.has(x))) {
    const v = m.view(id);
    if (!v) blocked = `${id}: closed before reporting succeeded`;
    else if (v.outcome?.outcome === 'failed' || v.outcome?.gate === 'failed') blocked = `${id}: ${outcomeLine(v.outcome)}`;
    if (blocked) break;
  }
  return { met: [...met], unmet, ...(blocked ? { blocked } : {}) };
}

// ---- arming, the queue and release ----

/** Claude nodes working now, or launched with a prompt whose first turn has not begun. */
function workingCount(m: NodeManager): number {
  const working = (rt?: NodeRuntime) => !!rt && (!!rt.starting || (!!rt.session && rt.status?.state === 'working'));
  return m.registry.list().filter((n) => n.kind === 'claude' && working(m.runtimes.get(n.id))).length;
}

/**
 * Hold a new node back, with no process, when it has dependencies or must queue for daemon.maxWorking (a claude node,
 * unless `now`, while the cap is reached or others already queue). Returns whether it was held.
 */
export function arm(m: NodeManager, id: string, req: SpawnRequest, isolation: Isolation): boolean {
  const after = req.after ?? [], afterSuccess = req.afterSuccess ?? [];
  const max = loadConfig(null, m.home).daemon.maxWorking;
  const queue = req.kind === 'claude' && !req.now && max > 0 && (workingCount(m) >= max || m.list().some((v) => v.status.state === 'queued'));
  if (!after.length && !afterSuccess.length && !queue) return false;
  const rec = m.registry.update(id, { pending: { after, afterSuccess, met: [], prompt: req.prompt, isolation, ...(req.now ? { now: true } : {}) } })!;
  m.runtimes.get(id)!.status = { state: 'armed', changedAt: Date.now() };
  if (after.length || afterSuccess.length) m.logEvent(id, 'arm', { parentId: rec.parentId, after, afterSuccess });
  schedule(m);
  return true;
}

const scheduled = new WeakSet<NodeManager>();

/** schedule once, after the current task: a burst of node events walks the pending nodes once. */
export function scheduleSoon(m: NodeManager): void {
  if (scheduled.has(m)) return;
  scheduled.add(m);
  queueMicrotask(() => { scheduled.delete(m); schedule(m); });
}

/**
 * Walk the armed and queued nodes in creation order: show what each waits on, tell the parent once when a failed
 * dependency blocks one, and launch each whose dependencies are met while daemon.maxWorking has room.
 */
function schedule(m: NodeManager): void {
  if (m.stopped) return;
  let working = workingCount(m);
  for (const rec of m.registry.list()) {
    const p = rec.pending, rt = m.runtimes.get(rec.id)!;
    if (!p || rt.restored) continue;
    const { met, unmet, blocked } = checkDeps(m, p, rec.createdAt);
    if (met.length !== p.met.length || blocked !== p.blocked) {
      m.registry.update(rec.id, { pending: { ...p, met, blocked } });
      if (!unmet.length) m.logEvent(rec.id, 'release', { after: p.after, afterSuccess: p.afterSuccess });
      if (blocked) blockedNotice(m, rec.id, blocked);
    }
    const max = loadConfig(null, m.home).daemon.maxWorking;
    let state: AgentState = 'armed', activity: string;
    if (unmet.length) activity = blocked ? `blocked by ${blocked}` : `after ${unmet.join(', ')}`;
    else if (rec.kind === 'claude' && !p.now && max > 0 && working >= max) {
      state = 'queued';
      activity = `queued: ${working} working, daemon.maxWorking ${max}`;
    } else {
      release(m, rec.id);
      if (rec.kind === 'claude') working++;
      continue;
    }
    const cur = rt.status!;
    if (cur.state === state && cur.activity === activity) continue;
    if (state === 'queued' && cur.state !== 'queued') m.logEvent(rec.id, 'queue', { working, maxWorking: max });
    m.setStatus(rec.id, { ...cur, state, activity, changedAt: Date.now() }, false);
  }
}

function blockedNotice(m: NodeManager, id: string, blocked: string): void {
  const rec = m.registry.get(id)!;
  m.logEvent(id, 'block', { by: blocked });
  if (!rec.parentId) return;
  const text = `${id} "${rec.title}" will not launch: blocked by ${blocked}. It launches if that node later reports succeeded; close it to drop it.`;
  deliver(m, DAEMON, rec.parentId, text, { fromLabel: `tiller (armed ${id} blocked)`, replyTo: null }).catch(logError);
}

/** Launch a held node as its spawn would have. A failure drops it and tells its parent. */
function release(m: NodeManager, id: string): void {
  const rec = m.registry.get(id)!, p = rec.pending as Pending, rt = m.runtimes.get(id)!;
  m.registry.update(id, { pending: undefined });
  m.logEvent(id, 'launch', p.isolation === 'worktree' ? { isolation: 'worktree' } : {});
  const fail = (err: Error) => {
    if (!m.registry.get(id)) return;
    m.logEvent(id, 'launch-failed', { error: err.message });
    if (rec.parentId) deliver(m, DAEMON, rec.parentId, `${id} "${rec.title}" failed to launch and was removed: ${err.message}`, { fromLabel: `tiller (armed ${id} failed)`, replyTo: null }).catch(logError);
    m.discard(id);
    m.emit('removed', id);
  };
  try {
    if (p.isolation === 'worktree') {
      if (p.prompt) rt.starting = true; // the worktree takes a while; hold its maxWorking slot meanwhile
      m.setStatus(id, { ...rt.status!, state: 'unknown', activity: 'creating worktree', changedAt: Date.now() }, false);
      addWorktree(m, id, p.prompt).then(() => m.emitNode(id), fail);
      return;
    }
    m.writeFiles(id);
    rt.status = { state: initialState(rec.kind), changedAt: Date.now() };
    m.launch(id, p.prompt, false);
    m.emitNode(id);
  } catch (err) {
    fail(err as Error);
  }
}

// ---- notify_when ----

const NOTIFY_TTL_MS = 12 * 3600_000;
export type NotifyWhen = { ids: string[]; when: 'all' | 'any'; of: 'turn' | 'success' };
/** since: per id, the turn start (or report time) that counts: the turn in progress at registration, else a later one. */
export interface Watch extends NotifyWhen { caller: string; at: number; since: Record<string, number> }
/** Managers whose node events already re-check the watches. */
const listening = new WeakSet<NodeManager>();

/** One line per id: its outcome when it reported one, else its state. */
function line(m: Mgr, id: string): string {
  const v = m.view(id);
  if (!v) return `${id}: closed`;
  const o = v.outcome;
  if (o) return `${id}: ${outcomeLine(o)}`;
  return `${id}: ${v.status.exited ? 'exited' : v.status.state}`;
}

function finished(m: Mgr, w: Watch, id: string): boolean {
  if (w.of === 'turn') return turnDone(m, id, w.since[id]);
  const v = m.view(id);
  return !v || !!v.status.exited || (v.outcome?.at ?? -Infinity) >= w.since[id];
}

const ACTIVE = ['working', 'waiting', 'blocked'];

function check(m: Mgr & Pick<NodeManager, 'on'>, all: Map<string, Watch>, key: string): void {
  const w = all.get(key)!;
  const done = w.ids.filter((id) => finished(m, w, id));
  if (w.when === 'all' ? done.length < w.ids.length : !done.length) return;
  all.delete(key);
  const text = `${done.length} of ${w.ids.length} finished:\n${w.ids.map((id) => line(m, id)).join('\n')}`;
  deliver(m as NodeManager, DAEMON, w.caller, text, { fromLabel: `tiller (notify_when ${w.when} of ${w.of})`, replyTo: null }).catch(logError);
}

/** Whether `caller` has a pending notify_when that covers `id`. */
export function watching(m: Partial<Pick<NodeManager, 'runtimes'>>, caller: string, id: string): boolean {
  return [...(m.runtimes?.get(caller)?.watches?.values() ?? [])].some((w) => w.ids.includes(id));
}

/**
 * Register a one-shot notice to `caller` when all or any of `ids` finish (a turn, or a report_outcome). Replaces the
 * caller's pending one for the same id set. Returns whether it replaced one. The message may go out before this returns.
 */
export function notifyWhen(m: NodeManager, caller: string, req: NotifyWhen): { replaced: boolean } {
  if (!listening.has(m)) {
    listening.add(m);
    const sweep = () => {
      const now = Date.now();
      for (const { watches } of m.runtimes.values()) {
        for (const [k, w] of watches ?? []) {
          if (now - w.at > NOTIFY_TTL_MS) watches!.delete(k);
          else check(m, watches!, k);
        }
      }
    };
    m.on('node', sweep);
    m.on('removed', sweep);
  }
  const all = (m.runtimes.get(caller)!.watches ??= new Map()); // the caller's runtime goes, and its watches with it, when it is closed
  const ids = [...new Set(req.ids)].sort();
  const key = `${caller}\0${ids.join(',')}`;
  const replaced = all.has(key);
  const now = Date.now();
  const since = Object.fromEntries(ids.map((id) => [id, ACTIVE.includes(m.view(id)?.status.state ?? '') ? m.turnStartedAt(id) ?? now : now]));
  all.set(key, { ...req, ids, caller, at: now, since });
  check(m, all, key);
  return { replaced };
}
