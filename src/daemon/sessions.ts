// Per-tree session directories, <home>/sessions/<rootId>: notes that outlive a node's context (handoff.md and the like),
// meta.json, and events.jsonl, the daemon's log of what happened in the tree. Keyed by rootId, so restart keeps them.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { outcomeLine } from '../shared/format.js';
import { NEEDS_YOU_STATES, type AgentState, type DigestItem, type Outcome } from '../shared/protocol.js';
import { logError } from './util.js';

export const SESSIONS_DIR = 'sessions';
export const HANDOFF = 'handoff.md';
const EVENTS = 'events.jsonl';
const DAY_MS = 86_400_000;

export interface SessionMeta { rootId: string; title: string; cwd: string; createdAt: number; closedAt?: number }

export const sessionDir = (home: string, rootId: string): string => join(home, SESSIONS_DIR, rootId);
export const eventsFile = (dir: string): string => join(dir, EVENTS);

/** The first prompt after a restart that names none: a pointer at the handoff note, when there is one. */
export const handoffPrompt = (dir: string): string | undefined =>
  existsSync(join(dir, HANDOFF)) ? `Read ${join(dir, HANDOFF)} first; it is your own handoff from before this restart.` : undefined;

/** Create the directory (0700) and its meta.json if missing. Cheap enough to call on every launch. */
export function ensureSession(home: string, meta: SessionMeta): string {
  const dir = sessionDir(home, meta.rootId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), { flag: 'wx' }); } catch { /* exists */ }
  return dir;
}

function readMeta(dir: string): SessionMeta | undefined {
  try { return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as SessionMeta; } catch { return undefined; }
}

/** Record that the tree's root closed; the sweep deletes the directory sessionsKeepDays later. */
export function markClosed(home: string, rootId: string, at = Date.now()): void {
  const dir = sessionDir(home, rootId);
  const meta = readMeta(dir);
  if (meta) writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...meta, closedAt: at }, null, 2));
}

export interface SessionInfo extends Partial<SessionMeta> { rootId: string; dir: string; files: number; bytes: number; newest: number }

export function listSessions(home: string): SessionInfo[] {
  const root = join(home, SESSIONS_DIR);
  let ids: string[];
  try { ids = readdirSync(root); } catch { return []; }
  return ids.flatMap((rootId) => {
    const dir = join(root, rootId);
    try {
      const stats = readdirSync(dir).map((f) => statSync(join(dir, f)));
      const newest = Math.max(statSync(dir).mtimeMs, ...stats.map((s) => s.mtimeMs));
      return [{ ...readMeta(dir), rootId, dir, files: stats.length, bytes: stats.reduce((n, s) => n + s.size, 0), newest }];
    } catch { return []; } // not a directory, or gone meanwhile
  });
}

/**
 * Delete the directories of trees whose root is gone and that have been quiet for keepDays: closed that long ago, or,
 * with no closedAt, no file touched for that long. A directory whose root still exists is never swept.
 */
export function sweepSessions(home: string, existing: Set<string>, keepDays: number, now = Date.now()): string[] {
  const cutoff = now - keepDays * DAY_MS;
  const removed: string[] = [];
  for (const s of listSessions(home)) {
    if (existing.has(s.rootId) || (s.closedAt ?? s.newest) >= cutoff) continue;
    rmSync(s.dir, { recursive: true, force: true });
    removed.push(s.rootId);
  }
  return removed;
}

// ---- event log ----

export type SessionEvent = { ts: number; type: string; id: string; title?: string } & Record<string, unknown>;

const writes = new Map<string, Promise<void>>();

/** Append one JSON line, in call order per file, without blocking the caller. A failed write is logged and dropped. */
export function appendLine(file: string, value: unknown): void {
  const next = (writes.get(file) ?? Promise.resolve()).then(() => appendFile(file, `${JSON.stringify(value)}\n`)).catch(logError);
  writes.set(file, next);
  void next.then(() => { if (writes.get(file) === next) writes.delete(file); });
}

export const appendEvent = (dir: string, ev: SessionEvent): void => appendLine(eventsFile(dir), ev);

/** Resolves once every pending append has landed (for tests and shutdown). */
export const flushEvents = async (): Promise<void> => { await Promise.all(writes.values()); };

/** Events at or after `since`, oldest first; unreadable lines are skipped. */
export function readEvents(dir: string, since = 0): SessionEvent[] {
  let raw: string;
  try { raw = readFileSync(eventsFile(dir), 'utf8'); } catch { return []; }
  return raw.split('\n').flatMap((l) => {
    try { const e = JSON.parse(l) as SessionEvent; return e.ts >= since ? [e] : []; } catch { return []; }
  });
}

/** "90s", "15m", "2h" or "3d" as milliseconds; undefined when malformed. */
export function parseSince(s: string): number | undefined {
  const m = /^(\d+)([smhd])$/.exec(s.trim());
  return m ? Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: DAY_MS }[m[2] as 's' | 'm' | 'h' | 'd'] : undefined;
}

/** One readable line: local time, node, type and the event's own fields. */
export function formatEvent(e: SessionEvent): string {
  const { ts, type, id, title, ...rest } = e;
  const time = new Date(ts).toLocaleString('sv-SE').slice(5, 19); // MM-DD HH:MM:SS
  const detail = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v.length > 120 ? `${v.slice(0, 120)}…` : v) : v}`).join(' ');
  return `${time}  ${(title ?? '').slice(0, 24).padEnd(24)} ${id}  ${type.padEnd(8)} ${detail}`;
}

// ---- away digest ----

const RANK: Record<DigestItem['kind'], number> = { needsYou: 0, errored: 1, finished: 2 };

/**
 * Per node, what the log says happened since the human looked away: still blocked or waiting (with the question or
 * activity), errored or failed (with the outcome line), or finished (with the outcome line). Needs-you first, newest first within.
 */
export function buildDigest(events: SessionEvent[]): DigestItem[] {
  const byNode = new Map<string, { title: string; state?: SessionEvent; outcome?: SessionEvent }>();
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    const n = byNode.get(e.id) ?? { title: e.title ?? e.id };
    if (e.title) n.title = e.title;
    if (e.type === 'state') n.state = e;
    else if (e.type === 'outcome') n.outcome = e;
    byNode.set(e.id, n);
  }
  const items: DigestItem[] = [];
  for (const [id, { title, state, outcome }] of byNode) {
    const to = state?.to as AgentState | undefined;
    const at = Math.max(state?.ts ?? 0, outcome?.ts ?? 0);
    const text = (...xs: unknown[]) => xs.find((x): x is string => typeof x === 'string' && x !== '');
    const reported = outcome && outcomeLine(outcome as unknown as Outcome); // an outcome event's data is the Outcome
    if (to && NEEDS_YOU_STATES.includes(to) && !state!.exited) items.push({ id, title, kind: 'needsYou', text: text(state!.activity, state!.message), at });
    else if (state?.errored || outcome?.outcome === 'failed') items.push({ id, title, kind: 'errored', text: text(reported, state?.activity, state?.message), at });
    else if (outcome || to === 'done') items.push({ id, title, kind: 'finished', text: text(reported, state?.message), at });
  }
  return items.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.at - a.at);
}
