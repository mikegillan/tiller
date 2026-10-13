// Dependency launches (spawn after / afterSuccess) and notify_when: when a set of nodes counts as finished.
import { outcomeLine } from '../shared/format.js';
import type { NodeView, Pending } from '../shared/protocol.js';
import type { NodeManager } from './manager.js';
import { DAEMON, deliver } from './messaging.js';
import { logError } from './util.js';

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

// ---- notify_when ----

const NOTIFY_TTL_MS = 12 * 3600_000;
export type NotifyWhen = { ids: string[]; when: 'all' | 'any'; of: 'turn' | 'success' };
/** since: per id, the turn start (or report time) that counts: the turn in progress at registration, else a later one. */
interface Watch extends NotifyWhen { caller: string; at: number; since: Record<string, number> }
const watches = new WeakMap<object, Map<string, Watch>>();

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
  deliver(m as NodeManager, DAEMON, w.caller, text, { fromLabel: `orchestr8 (notify_when ${w.when} of ${w.of})`, replyTo: null }).catch(logError);
}

/** Whether `caller` has a pending notify_when that covers `id`. */
export function watching(m: object, caller: string, id: string): boolean {
  return [...(watches.get(m)?.values() ?? [])].some((w) => w.caller === caller && w.ids.includes(id));
}

/**
 * Register a one-shot notice to `caller` when all or any of `ids` finish (a turn, or a report_outcome). Replaces the
 * caller's pending one for the same id set. Returns whether it replaced one. The message may go out before this returns.
 */
export function notifyWhen(m: NodeManager, caller: string, req: NotifyWhen): { replaced: boolean } {
  let all = watches.get(m);
  if (!all) {
    const mine = (all = new Map());
    watches.set(m, mine);
    const sweep = () => {
      const now = Date.now();
      for (const [k, w] of mine) {
        if (!m.view(w.caller) || now - w.at > NOTIFY_TTL_MS) mine.delete(k);
        else check(m, mine, k);
      }
    };
    m.on('node', sweep);
    m.on('removed', sweep);
  }
  const ids = [...new Set(req.ids)].sort();
  const key = `${caller}\0${ids.join(',')}`;
  const replaced = all.has(key);
  const now = Date.now();
  const since = Object.fromEntries(ids.map((id) => [id, ACTIVE.includes(m.view(id)?.status.state ?? '') ? m.turnStartedAt(id) ?? now : now]));
  all.set(key, { ...req, ids, caller, at: now, since });
  check(m, all, key);
  return { replaced };
}
