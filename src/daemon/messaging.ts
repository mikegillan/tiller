import { randomBytes } from 'node:crypto';
import type { NodeView, SendResult } from '../shared/protocol.js';
import type { NodeManager } from './manager.js';

export const RATE_MS = 10_000;
export const QUEUE_CAP = 16;
export const QUEUE_TTL_MS = 5 * 60_000;
export const RECEIPT_MS = 8000;
export const WAITING_NOTICE_MS = 15 * 60_000;
/** Caller ids that are not nodes. Both have full scope. */
export const HUMAN = 'human';
export const DAEMON = 'orchestr8';

export type Mgr = Pick<NodeManager, 'view' | 'session' | 'on' | 'off'>;
export interface DeliverOpts {
  /** Header after `from:`. Defaults to `<title> (<id>)` of the sender. */
  fromLabel?: string;
  /** Defaults to the sender's id; null prints `none`. */
  replyTo?: string | null;
}

// ---- scope (PLAN §5): self, ancestors, siblings, descendants ----

function ancestors(m: Mgr, id: string): string[] {
  const out: string[] = [];
  for (let p = m.view(id)?.parentId; p && !out.includes(p); p = m.view(p)?.parentId) out.push(p);
  return out;
}

export function isDescendant(m: Mgr, ancestor: string, id: string): boolean {
  return ancestors(m, id).includes(ancestor);
}

export function inScope(m: Mgr, caller: string, target: string): boolean {
  if (caller === HUMAN || caller === DAEMON || caller === target) return true;
  if (isDescendant(m, target, caller) || isDescendant(m, caller, target)) return true;
  const parent = m.view(caller)?.parentId;
  return !!parent && m.view(target)?.parentId === parent;
}

// ---- delivery ----

interface Entry { id: string; from: string; to: string; label: string; replyTo: string | null; text: string; timer?: NodeJS.Timeout }
interface State {
  last: Map<string, number>;
  queues: Map<string, Entry[]>;
  locks: Map<string, Promise<unknown>>;
  /** Queued messages and their eventual outcome. prune: never trimmed, fine for a daemon that restarts; cap if it grows. */
  status: Map<string, { from: string; result: SendResult }>;
}
type Attempt = { result: SendResult } | { wait: string };

const states = new WeakMap<object, State>();

function stateOf(m: Mgr): State {
  let s = states.get(m);
  if (s) return s;
  const st: State = { last: new Map(), queues: new Map(), locks: new Map(), status: new Map() };
  states.set(m, st);
  const kick = (id: string) => { if (st.queues.get(id)?.length) void drain(m, st, id); };
  m.on('node', (v: NodeView) => kick(v.id));
  m.on('removed', kick);
  return st;
}

/** Serialize work per target so two deliveries never race for one idle composer. */
function locked<T>(s: State, to: string, fn: () => Promise<T>): Promise<T> {
  const run = (s.locks.get(to) ?? Promise.resolve()).then(fn);
  s.locks.set(to, run.catch(() => {}));
  return run;
}

const verifiedIdle = (v: NodeView) => v.status.state === 'done' && !v.status.stale && v.status.doneSource === 'stop';
const gone: SendResult = { outcome: 'gone', retryable: false, detail: 'target does not exist or has exited' };
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ');

async function attempt(m: Mgr, e: Entry): Promise<Attempt> {
  const check = (): Attempt | undefined => {
    const v = m.view(e.to);
    if (!v || v.status.exited) return { result: gone };
    if (!verifiedIdle(v)) return { wait: `target is ${v.status.state}${v.status.doneSource ? ` (done via ${v.status.doneSource})` : ''}, not verified idle` };
  };
  const early = check();
  if (early) return early;
  const session = m.session(e.to);
  if (!session) return { result: gone };
  await session.flush();
  const late = check();
  if (late) return late;
  const screen = session.classifyScreen();
  if (screen !== 'prompt') return { wait: `screen shows ${screen === 'dialog' ? 'a dialog' : 'no composer prompt'}` };
  if (session.composerText()) return { wait: 'composer has unsent text' };

  const nonce = randomBytes(6).toString('base64url');
  const body = e.text.replaceAll('\x1b', '');
  const envelope = `--- O8 MESSAGE ${nonce} ---\nfrom: ${e.label}\nreply-to: ${e.replyTo ?? 'none'}\n${body}\n--- END O8 MESSAGE ${nonce} ---`;
  // Subscribe before writing: a fast target can answer before paste() returns.
  let onHook!: (id: string, ev: { hook_event_name?: string; prompt?: unknown }) => void;
  let timer: NodeJS.Timeout | undefined;
  const receipt = new Promise<boolean>((resolve) => {
    onHook = (id, ev) => { if (id === e.to && ev.hook_event_name === 'UserPromptSubmit' && String(ev.prompt ?? '').includes(nonce)) resolve(true); };
    timer = setTimeout(() => resolve(false), RECEIPT_MS);
  });
  m.on('hook', onHook);
  try {
    await session.paste(envelope);
    const seen = await receipt;
    return { result: seen
      ? { outcome: 'delivered', retryable: false }
      : { outcome: 'stalled', retryable: false, detail: `no UserPromptSubmit carrying the message seen within ${RECEIPT_MS / 1000} s; it may still land` } };
  } finally {
    clearTimeout(timer);
    m.off('hook', onHook);
  }
}

function drain(m: Mgr, s: State, to: string): Promise<void> {
  return locked(s, to, async () => {
    const q = s.queues.get(to) ?? [];
    while (q.length) {
      const e = q[0];
      const a = await attempt(m, e);
      if ('wait' in a) return;
      q.shift();
      clearTimeout(e.timer);
      s.status.get(e.id)!.result = { ...a.result, messageId: e.id };
    }
  });
}

function enqueue(m: Mgr, s: State, e: Entry, detail: string): SendResult {
  const q = s.queues.get(e.to) ?? [];
  s.queues.set(e.to, q);
  if (q.length >= QUEUE_CAP) return { outcome: 'queueFull', retryable: true, detail: `${QUEUE_CAP} messages already queued for ${e.to}`, messageId: e.id };
  q.push(e);
  const result: SendResult = { outcome: 'queued', retryable: false, detail, messageId: e.id };
  s.status.set(e.id, { from: e.from, result });
  e.timer = setTimeout(() => void locked(s, e.to, async () => {
    const i = q.indexOf(e);
    if (i < 0) return;
    q.splice(i, 1);
    s.status.get(e.id)!.result = { outcome: 'expired', retryable: true, detail: 'target never became idle within 5 min', messageId: e.id };
  }), QUEUE_TTL_MS);
  e.timer.unref();
  void drain(m, s, e.to); // the target may have gone idle while we were deciding to queue
  return result;
}

/** Final (or current, if still queued) outcome of a message the caller sent. */
export function messageStatus(m: Mgr, caller: string, messageId: string): SendResult | undefined {
  const r = stateOf(m).status.get(messageId);
  return r && (r.from === caller || caller === HUMAN) ? r.result : undefined;
}

/** PLAN §6. Resolves once the message is delivered, stalled, refused or queued. */
export async function deliver(m: Mgr, fromId: string, toId: string, text: string, opts: DeliverOpts = {}): Promise<SendResult> {
  const s = stateOf(m);
  const id = `m-${randomBytes(4).toString('hex')}`;
  const out = (r: SendResult): SendResult => ({ ...r, messageId: id });
  const refuse = (detail: string, retryable = false) => out({ outcome: 'refused', retryable, detail });

  const target = m.view(toId);
  if (!target) return out(gone);
  if (fromId === toId) return refuse('cannot send to yourself');
  if (!inScope(m, fromId, toId)) return refuse('target is outside your lineage (self, ancestors, siblings, descendants)');
  if (target.status.exited) return out(gone);
  if (target.kind !== 'claude') return refuse('not an agent node; use write for terminals');

  const key = `${fromId}\0${toId}`;
  const wait = (s.last.get(key) ?? -Infinity) + RATE_MS - Date.now();
  if (fromId !== DAEMON && wait > 0) return refuse(`rate limited, retry in ${Math.ceil(wait / 1000)} s`, true);
  s.last.set(key, Date.now());

  const from = m.view(fromId);
  const label = opts.fromLabel ?? (from ? `${oneLine(from.title)} (${fromId})` : fromId);
  const entry: Entry = { id, from: fromId, to: toId, label: oneLine(label), replyTo: opts.replyTo === undefined ? fromId : opts.replyTo, text };
  const q = s.queues.get(toId);
  if (q?.length) return enqueue(m, s, entry, `behind ${q.length} queued message(s)`); // keep order
  const a = await locked(s, toId, () => attempt(m, entry));
  return 'wait' in a ? enqueue(m, s, entry, a.wait) : out(a.result);
}

// ---- station notices (PLAN §7) ----

/** Tell a parent when its child exits, errors, or sits on a question. Once per episode. Returns a disposer. */
export function startNotices(m: Mgr): () => void {
  const notified = new Set<string>();
  const timers = new Map<string, NodeJS.Timeout>();
  const notice = (v: NodeView, reason: string) => {
    if (!v.parentId || notified.has(v.id)) return;
    notified.add(v.id);
    const body = v.status.lastAssistantMessage?.slice(0, 300) ?? 'No further details.';
    deliver(m, DAEMON, v.parentId, body, { fromLabel: `orchestr8 (child ${v.id} "${v.title}" stopped: ${reason})`, replyTo: null }).catch(() => {});
  };
  const onNode = (v: NodeView) => {
    if (!v.parentId) return;
    const { state, exited, errored } = v.status;
    if (state !== 'waiting') {
      clearTimeout(timers.get(v.id));
      timers.delete(v.id);
    } else if (!timers.has(v.id)) {
      const t = setTimeout(() => {
        timers.delete(v.id);
        const cur = m.view(v.id);
        if (cur?.status.state === 'waiting') notice(cur, 'question-unanswered');
      }, WAITING_NOTICE_MS);
      t.unref();
      timers.set(v.id, t);
    }
    if (exited) notice(v, 'exited');
    else if (state === 'done') { if (errored) notice(v, 'turn-errored'); else notified.delete(v.id); } // a clean turn re-arms
  };
  m.on('node', onNode);
  return () => { m.off('node', onNode); for (const t of timers.values()) clearTimeout(t); };
}
