// The memory store: one SQLite file per account under <home>/memory, and the only module that loads node:sqlite. It
// loads lazily, in the first open, so a Node without the builtin only turns memory off. Methods the manager calls never
// throw (they log once per account and reason, and return empty); methods behind the tools throw errors to show as
// written. The store never checks the opt-in: its callers do, and a script using it directly writes whatever the config.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { claudeAccounts } from './claude-accounts.js';
import { loadConfig } from './config.js';
import {
  accountKey, ADD_KINDS, firstErrorLine, ftsTerms, ITEM_KINDS, itemRef, LIMITS, normalizeDedupe, pinDedupe, redact, SCHEMA_V1, SCHEMA_VERSION,
  type Actor, type Arm, type Cause, type Derived, type DigestCandidates, type DigestRole, type DigestSource, type EpisodeInput,
  type EpisodeKind, type EpisodeSkeleton, type HistoryEntry, type InjectionRow, type InjectionView, type ItemKind, type ItemRow,
  type ItemView, type MemoryScope,
} from './memory-schema.js';
import { logError } from './util.js';

const DAY = 86_400_000;
const MB = 1024 * 1024;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A refusal or a missing item, for the caller as written. Anything else a tool-facing method throws is "memory is unavailable". */
export class MemoryError extends Error {}
/** Why a file cannot be used; the reason without the "memory is unavailable: " prefix. */
class Unavailable extends Error {}

export interface MemoryStoreOptions {
  /** The clock for the rows the store stamps itself; scripts backdate with it. Episodes keep their own ts. */
  now?: () => number;
  log?: (err: unknown) => void;
}

/** One account file's health, for memory_status. */
export interface MemoryDbStatus {
  key: string;
  path: string;
  /** ok; missing (no file yet); or "off: <reason>" / "broken: <reason>". */
  state: string;
  schema?: number;
  /** The file and its WAL on disk. */
  sizeBytes?: number;
  /** (page_count - freelist_count) * page_size, the measure memory.maxMB limits. */
  usedBytes?: number;
  /** Still over memory.maxMB after the last eviction. */
  overLimit?: boolean;
  counts?: { items: Record<ItemKind, number>; retracted: number; tombstones: number; pinned: number; episodes: number; injections: number };
  /** Corrupt files set aside as <key>.corrupt-<ts>.db. */
  quarantined: string[];
}

/** One digest arm's metrics over the nodes whose first injection row falls in the window (null: no node to measure). */
export interface ArmStats {
  nodes: number;
  /** Of nodes that ran a gate, the share whose first run passed. */
  firstPassGate: number | null;
  /** Of nodes that reported, the share whose latest outcome failed. */
  failedOutcomes: number | null;
  /** Gate runs per node whose latest outcome succeeded. */
  gateRunsPerSuccess: number | null;
  /** Means over closed nodes. */
  spentUsd: number | null;
  wallMs: number | null;
  humanSendsPerNode: number | null;
  injectedItems: number;
  /** [m<id>] cites of a node's injected items in its outcomes, per injected item. */
  citesPerInjected: number | null;
  forgetsOfInjected: number;
  /** Failed gate runs whose first error line is in a pitfall recorded before the node launched, and of those in its digest. */
  repeatedPitfalls: number;
  repeatedInjectedPitfalls: number;
}

export type AddResult = { id: number; existing?: true; revived?: true };

const EMPTY_CANDIDATES = (): DigestCandidates => ({ pins: [], ledger: [], openQuestions: [], procedures: [], pitfalls: [], notes: [], matched: [] });

/** A MATCH expression from search terms (ftsTerms): each quoted, joined with OR, so no FTS5 syntax gets through; '' for none. */
export const ftsQuery = (terms: readonly string[]): string => terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');

/**
 * An item may enter a digest when the human or the daemon wrote it, when the tree's root did, or when its node's newest
 * outcome succeeded with no failed gate. Over `items i`.
 */
const ELIGIBLE = `(i.author IN ('human', 'daemon') OR i.node_id = i.root_id OR coalesce((
  SELECT json_extract(e.data, '$.outcome') = 'succeeded' AND coalesce(json_extract(e.data, '$.gate'), '') <> 'failed'
  FROM episodes e WHERE e.node_id = i.node_id AND e.kind = 'outcome' ORDER BY e.ts DESC, e.id DESC LIMIT 1), 0))`;

/** What eviction and purge keep of an episode's data: its metric fields, else {}. */
function skeleton(kind: string, data: Record<string, unknown>): Record<string, unknown> {
  const keep: { [K in keyof EpisodeSkeleton]: (keyof EpisodeSkeleton[K])[] } = {
    outcome: ['outcome', 'gate'],
    gate: ['ok', 'command'],
    close: ['spentUsd', 'createdAt', 'closedAt', 'branchFate', 'outcome', 'gate'],
  };
  const fields: string[] = keep[kind as keyof EpisodeSkeleton] ?? [];
  return Object.fromEntries(fields.filter((f) => data[f] !== undefined).map((f) => [f, data[f]]));
}

function view(r: ItemRow, withBody = false): ItemView {
  return {
    id: r.id, kind: r.kind, text: r.text, ...(withBody ? { body: r.body } : {}), author: r.author,
    ...(r.node_id ? { nodeId: r.node_id } : {}), ...(r.root_id ? { rootId: r.root_id } : {}),
    ...(r.harness ? { harness: r.harness } : {}), ...(r.model ? { model: r.model } : {}),
    seen: r.seen, pinned: r.pinned === 1, cites: r.cites, gets: r.gets, createdAt: r.created_at, updatedAt: r.updated_at,
    ...(r.supersedes !== null ? { supersedes: r.supersedes } : {}),
    ...(r.invalid_at !== null && r.invalid_kind !== null ? { invalid: {
      at: r.invalid_at, kind: r.invalid_kind, ...(r.invalid_by ? { by: r.invalid_by } : {}), ...(r.invalid_reason ? { reason: r.invalid_reason } : {}),
    } } : {}),
    ...(r.text === '' ? { tombstone: r.dedupe.startsWith('purged:') ? 'purged' as const : 'evicted' as const } : {}),
  };
}

const injectionView = (r: InjectionRow): InjectionView =>
  ({ sessionId: r.session_id, arm: r.arm, cause: r.cause, itemIds: JSON.parse(r.item_ids) as number[], text: r.text, ts: r.ts });

const errcode = (err: unknown): number => ((err as { errcode?: number }).errcode ?? -1) & 0xff;
const pragma = (db: DatabaseSync, name: string): number => Number(Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0] ?? 0);
const used = (db: DatabaseSync): number => (pragma(db, 'page_count') - pragma(db, 'freelist_count')) * pragma(db, 'page_size');

function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Replace rows by id with changed copies, deleting them first. An UPDATE that shrinks a row leaves its page as full as
 * before, while a DELETE rebalances the b-tree, so this is how eviction frees pages. Foreign keys are off for the batch,
 * so items keep their episode_id and supersedes; the triggers keep the FTS index in step.
 */
function rewrite(db: DatabaseSync, table: 'items' | 'episodes' | 'injections', rows: Record<string, SQLInputValue>[]): void {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]);
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    tx(db, () => {
      const del = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
      const ins = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (const row of rows) del.run(row.id);
      for (const row of rows) ins.run(...cols.map((c) => row[c]));
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export class MemoryStore implements DigestSource {
  private readonly now: () => number;
  private readonly log: (err: unknown) => void;
  private sqlite?: typeof import('node:sqlite');
  /** Set when memory cannot work in this process at all: no node:sqlite, or no FTS5. */
  private off?: string;
  private readonly dbs = new Map<string, DatabaseSync>();
  /** Files that failed to open, retried after LIMITS.store.retryBrokenMs. */
  private readonly down = new Map<string, { state: 'off' | 'broken'; reason: string; at: number }>();
  private readonly logged = new Set<string>();
  private readonly overLimit = new Set<string>();
  private readonly checks = new Map<string, NodeJS.Immediate | undefined>();
  private readonly enforcing = new Set<string>();

  constructor(readonly home: string, opts: MemoryStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? logError;
  }

  /** The file of an account's memory. Throws for an account not in claude.accounts, or any named one while the list is invalid. */
  accountFile(account: string | undefined): string {
    return this.fileOf(this.keyOf(account));
  }

  // --- Manager-facing: never throw ---

  /** Append derive()'s episode and upsert its items, redacting everything again. Creates the file. */
  apply(scope: MemoryScope, derived: Derived): void {
    this.quiet(scope.account, undefined, () => {
      const { episode, items, cites } = redact(derived);
      const db = this.db(scope.account, true)!;
      tx(db, () => {
        const repo = this.repo(db, scope, true)!;
        const episodeId = this.episode(db, repo, scope, episode);
        for (const it of items) {
          this.upsert(db, {
            repo_id: repo, kind: it.kind, text: it.text, body: it.body ?? '', author: it.author, dedupe: it.dedupe,
            node_id: scope.nodeId ?? null, root_id: scope.rootId ?? null, harness: scope.harness ?? null, model: scope.model ?? null,
            episode_id: episodeId, now: episode.ts,
          });
        }
        if (cites.length) {
          db.prepare('UPDATE items SET cites = cites + 1 WHERE repo_id = ? AND id IN (SELECT value FROM json_each(?))').run(repo, JSON.stringify([...new Set(cites)]));
        }
      });
    });
  }

  /** The node's episodes since its latest outcome, oldest first: derive()'s history. */
  nodeHistory(scope: MemoryScope, nodeId: string): HistoryEntry[] {
    return this.quiet(scope.account, [], () => {
      const db = this.db(scope.account, false);
      if (!db) return [];
      const rows = db.prepare(`SELECT kind, ts, data FROM episodes WHERE node_id = :node
        AND id > coalesce((SELECT max(id) FROM episodes WHERE node_id = :node AND kind = 'outcome'), 0) ORDER BY id`).all({ node: nodeId });
      return rows.map((r) => ({ kind: r.kind, ts: r.ts, data: JSON.parse(String(r.data)) }) as HistoryEntry);
    });
  }

  /** The digest's eligible, valid candidates (DigestSource). The open-question window and procedure recency use `now`. */
  candidates(scope: MemoryScope, q: { role: DigestRole; terms: string[]; now: number }): DigestCandidates {
    return this.quiet(scope.account, EMPTY_CANDIDATES(), () => {
      const db = this.db(scope.account, false);
      if (!db) return EMPTY_CANDIDATES();
      const repo = this.repo(db, scope, false) ?? -1;
      const c = LIMITS.candidates;
      const list = (where: string, limit: number, params: Record<string, SQLInputValue> = {}) => (db.prepare(
        `SELECT i.* FROM items i WHERE i.invalid_at IS NULL AND ${where} ORDER BY i.updated_at DESC, i.id DESC LIMIT ${limit}`,
      ).all({ repo, ...params }) as unknown as ItemRow[]).map((r) => view(r));
      const kind = (k: ItemKind) => `i.kind = '${k}' AND i.repo_id = :repo AND i.pinned = 0 AND ${ELIGIBLE}`;
      const halfLife = LIMITS.procedure.halfLifeDays * DAY;
      const weight = (v: ItemView) => v.seen * 0.5 ** ((q.now - v.updatedAt) / halfLife);
      const terms = ftsQuery(q.terms);
      return {
        pins: list('i.repo_id = :repo AND i.pinned = 1', c.pins),
        ledger: list(`i.kind = 'ledger' AND (i.repo_id = :repo OR i.root_id = :root) AND i.pinned = 0 AND ${ELIGIBLE}`, c.ledger, { root: scope.rootId ?? null }),
        openQuestions: list(`${kind('open_question')} AND i.updated_at >= :since`, c.openQuestions, { since: q.now - c.openQuestionDays * DAY }),
        // prune: ranked in JS over every eligible procedure in the repo; rank in SQL if a repo gathers thousands.
        procedures: list(kind('procedure'), -1).sort((a, b) => weight(b) - weight(a)).slice(0, c.procedures),
        pitfalls: list(kind('pitfall'), c.pitfalls),
        notes: list(kind('note'), c.notes),
        matched: q.role === 'worker' && terms ? (db.prepare(`SELECT i.* FROM items_fts JOIN items i ON i.id = items_fts.rowid
          WHERE items_fts MATCH :terms AND i.repo_id = :repo AND i.kind IN ('ledger', 'procedure', 'pitfall', 'note')
            AND i.invalid_at IS NULL AND i.pinned = 0 AND ${ELIGIBLE}
          ORDER BY bm25(items_fts) LIMIT ${c.matched}`).all({ terms, repo }) as unknown as ItemRow[]).map((r) => view(r)) : [],
      };
    });
  }

  /** The newest fresh (non-resume) injection of a session, which a resume reuses; undefined when none or on any failure. */
  frozen(account: string | undefined, sessionId: string): InjectionView | undefined {
    return this.quiet(account, undefined, () => {
      const row = this.db(account, false)?.prepare(
        `SELECT * FROM injections WHERE session_id = ? AND cause <> 'resume' ORDER BY ts DESC, id DESC LIMIT 1`,
      ).get(sessionId) as InjectionRow | undefined;
      return row && injectionView(row);
    });
  }

  /** Record one launch's digest decision for the scope's node. Creates the file. */
  recordInjection(scope: MemoryScope, inj: { sessionId: string; arm: Arm; cause: Cause; itemIds: number[]; text: string }): void {
    this.quiet(scope.account, undefined, () => {
      const db = this.db(scope.account, true)!;
      tx(db, () => {
        db.prepare(`INSERT INTO injections (ts, session_id, node_id, root_id, repo_id, arm, cause, role, profile, harness, model, item_ids, text)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          this.now(), inj.sessionId, scope.nodeId ?? '', scope.rootId ?? scope.nodeId ?? '', this.repo(db, scope, true)!, inj.arm, inj.cause,
          scope.role ?? null, scope.profile ?? null, scope.harness ?? null, scope.model ?? null, JSON.stringify(inj.itemIds), redact(inj.text),
        );
      });
    });
  }

  /** Each account file's health: one account's, or every existing file's. Opens existing files only. */
  status(account?: string): MemoryDbStatus[] {
    let keys: string[];
    if (account === undefined) {
      keys = this.existingKeys();
    } else {
      try {
        keys = [this.keyOf(account)];
      } catch (err) {
        return [{ key: account, path: '', state: `off: ${(err as Error).message}`, quarantined: [] }];
      }
    }
    return keys.map((key) => this.statusOf(key));
  }

  /**
   * Enforce memory.maxMB on every account file that exists: past the limit, evict old content in order until the file
   * is under 0.9 x the limit, then reclaim the space. Batches yield to the event loop. Never creates a file or rejects.
   */
  async enforceLimit(maxMB: number): Promise<void> {
    for (const key of this.existingKeys()) await this.enforce(key, maxMB);
  }

  // --- Tool-facing: throw MemoryError as written, else "memory is unavailable: <reason>" ---

  search(scope: MemoryScope, q: { query: string; kind?: ItemKind; limit?: number; includeRetracted?: boolean }): ItemView[] {
    return this.loud(() => {
      const db = this.db(scope.account, false);
      const repo = db && this.repo(db, scope, false);
      const terms = ftsQuery(ftsTerms(q.query));
      if (!db || repo === undefined || !terms) return [];
      return (db.prepare(`SELECT i.* FROM items_fts JOIN items i ON i.id = items_fts.rowid
        WHERE items_fts MATCH :terms AND i.repo_id = :repo ${q.kind ? 'AND i.kind = :kind' : ''} ${q.includeRetracted ? '' : 'AND i.invalid_at IS NULL'}
        ORDER BY bm25(items_fts) LIMIT :limit`).all({
        terms, repo, ...(q.kind ? { kind: q.kind } : {}), limit: Math.min(q.limit ?? LIMITS.tools.search.default, LIMITS.tools.search.max),
      }) as unknown as ItemRow[]).map((r) => view(r));
    });
  }

  /** One item in full, counting the read. Another repository's item is "no such item". */
  get(scope: MemoryScope, id: number): ItemView {
    return this.loud(() => {
      const db = this.db(scope.account, false);
      const repo = db && this.repo(db, scope, false);
      if (!db || repo === undefined) throw new MemoryError(`no such item ${itemRef(id)}`);
      const row = this.item(db, repo, id);
      db.prepare('UPDATE items SET gets = gets + 1 WHERE id = ?').run(id);
      return view({ ...row, gets: row.gets + 1 }, true);
    });
  }

  /** memory_add. An agent may add LIMITS.perNode.adds; its supersedes hides the older item until later work records it again. */
  add(scope: MemoryScope, actor: Actor, input: { kind: ItemKind; text: string; body?: string; supersedes?: number }): AddResult {
    return this.loud(() => {
      if (!(ADD_KINDS as readonly string[]).includes(input.kind)) throw new MemoryError(`memory_add records ${ADD_KINDS.join(', ')}, not ${input.kind}`);
      const text = redact(input.text.trim()), body = redact(input.body ?? '');
      if (!text || text.length > LIMITS.item.text) throw new MemoryError(`text must be 1-${LIMITS.item.text} characters`);
      if (body.length > LIMITS.item.body) throw new MemoryError(`body must be at most ${LIMITS.item.body} characters`);
      const db = this.db(scope.account, true)!;
      return tx(db, () => {
        const repo = this.repo(db, scope, true)!;
        if (actor.kind === 'agent') this.cap(db, actor.nodeId, 'add', LIMITS.perNode.adds, 'memory_add');
        const old = input.supersedes === undefined ? undefined : this.item(db, repo, input.supersedes);
        if (old && actor.kind === 'agent' && old.pinned) throw new MemoryError(`${itemRef(old.id)} is pinned; pinned items are the human's to change`);
        const who = this.who(actor);
        const result = this.upsert(db, {
          repo_id: repo, kind: input.kind, text, body, author: actor.kind === 'human' ? 'human' : 'agent', dedupe: normalizeDedupe(input.kind, text),
          node_id: who.node_id, root_id: who.root_id, harness: who.harness, model: who.model, episode_id: null, now: this.now(),
        });
        if ('sticky' in result) throw new MemoryError(`retracted by the human as ${itemRef(result.sticky)}; not re-added`);
        const episodeId = this.episode(db, repo, { ...scope, ...this.episodeScope(actor) }, { kind: 'add', ts: this.now(), data: { itemId: result.id, actor: who.actor } });
        db.prepare('UPDATE items SET episode_id = ? WHERE id = ? AND episode_id IS NULL').run(episodeId, result.id);
        if (old && old.id !== result.id) {
          db.prepare('UPDATE items SET supersedes = ? WHERE id = ?').run(old.id, result.id);
          if (actor.kind === 'human' || old.invalid_at === null) {
            this.invalidate(db, old.id, actor.kind === 'human' ? 'superseded' : 'agent', who.actor, `superseded by ${itemRef(result.id)}`);
          }
        }
        return result;
      });
    });
  }

  /**
   * memory_forget. An agent's retraction (at most LIMITS.perNode.forgets) lasts until later work records the item again;
   * the human's is permanent. purge (human only) also blanks the item's episode and siblings and removes the bytes.
   */
  forget(scope: MemoryScope, actor: Actor, input: { id: number; reason: string; purge?: boolean }): ItemView {
    return this.loud(() => {
      if (input.purge && actor.kind !== 'human') throw new MemoryError('only the human can purge');
      const reason = redact(input.reason.trim()).slice(0, LIMITS.tools.reason);
      const db = this.db(scope.account, false);
      const repo = db && this.repo(db, scope, false);
      if (!db || repo === undefined) throw new MemoryError(`no such item ${itemRef(input.id)}`);
      const who = this.who(actor);
      const row = tx(db, () => {
        const item = this.item(db, repo, input.id);
        if (actor.kind === 'agent') {
          if (item.pinned) throw new MemoryError(`${itemRef(item.id)} is pinned; pinned items are the human's to change`);
          if (item.invalid_at !== null) throw new MemoryError(`${itemRef(item.id)} is already retracted`);
          this.cap(db, actor.nodeId, 'forget', LIMITS.perNode.forgets, 'memory_forget');
        }
        this.episode(db, repo, { ...scope, ...this.episodeScope(actor) }, { kind: 'forget', ts: this.now(), data: { itemId: item.id, actor: who.actor, reason } });
        if (input.purge) this.purge(db, item, reason);
        else this.invalidate(db, item.id, actor.kind === 'human' ? 'human' : 'agent', who.actor, reason);
        return this.item(db, repo, item.id);
      });
      if (input.purge) this.scrub(db);
      return view(row, true);
    });
  }

  /** memory_pin (human only): pin an item by id, restoring it if retracted, or pin new text as a human note; unpin undoes either. */
  pin(scope: MemoryScope, actor: Actor, input: { id?: number; text?: string; unpin?: boolean }): ItemView {
    return this.loud(() => {
      if (actor.kind !== 'human') throw new MemoryError('only the human can pin');
      if ((input.id === undefined) === (input.text === undefined)) throw new MemoryError('memory_pin takes exactly one of id and text');
      const text = input.text === undefined ? undefined : redact(input.text.trim());
      if (text !== undefined && (!text || text.length > LIMITS.tools.pinText)) throw new MemoryError(`text must be 1-${LIMITS.tools.pinText} characters`);
      const db = this.db(scope.account, !input.unpin && text !== undefined);
      const repo = db && this.repo(db, scope, !input.unpin && text !== undefined);
      if (!db || repo === undefined) throw new MemoryError(input.id === undefined ? 'no such pin' : `no such item ${itemRef(input.id)}`);
      const row = tx(db, () => {
        let id = input.id;
        if (text !== undefined) {
          const dedupe = pinDedupe(text);
          id = (db.prepare(`SELECT id FROM items WHERE repo_id = ? AND kind = 'note' AND dedupe = ?`).get(repo, dedupe) as { id: number } | undefined)?.id;
          if (id === undefined && input.unpin) throw new MemoryError('no such pin');
          id ??= Number((db.prepare(`INSERT INTO items (repo_id, kind, text, author, dedupe, pinned, created_at, updated_at)
            VALUES (?, 'note', ?, 'human', ?, 1, ?, ?) RETURNING id`).get(repo, text, dedupe, this.now(), this.now()) as { id: number }).id);
        }
        const item = this.item(db, repo, id!);
        if (input.unpin) db.prepare('UPDATE items SET pinned = 0, updated_at = ? WHERE id = ?').run(this.now(), item.id);
        else {
          db.prepare(`UPDATE items SET pinned = 1, updated_at = ?, invalid_at = NULL, invalid_kind = NULL, invalid_by = NULL, invalid_reason = NULL
            WHERE id = ?`).run(this.now(), item.id);
        }
        this.episode(db, repo, { ...scope, nodeId: 'human', rootId: 'human' }, { kind: 'pin', ts: this.now(), data: { itemId: item.id, ...(input.unpin ? { unpin: true } : {}) } });
        return this.item(db, repo, item.id);
      });
      return view(row, true);
    });
  }

  /** A node's injection rows, oldest first (memory_status { nodeId }). */
  injections(account: string | undefined, nodeId: string): InjectionView[] {
    return this.loud(() => (this.db(account, false)?.prepare('SELECT * FROM injections WHERE node_id = ? ORDER BY ts, id')
      .all(nodeId) as InjectionRow[] | undefined ?? []).map(injectionView));
  }

  /** The digest arms compared over the nodes whose first fresh injection is within `days` (memory_status). */
  stats(account: string | undefined, days: number): Record<Arm, ArmStats> {
    return this.loud(() => {
      const db = this.db(account, false);
      const firsts = (db?.prepare(`SELECT * FROM injections j WHERE cause <> 'resume' AND ts >= ?
        AND id = (SELECT min(id) FROM injections k WHERE k.node_id = j.node_id AND k.cause <> 'resume')`).all(this.now() - days * DAY) ?? []) as unknown as InjectionRow[];
      const of = (arm: Arm) => this.armStats(db as DatabaseSync, firsts.filter((r) => r.arm === arm)); // no file: no rows to read
      return { on: of('on'), off: of('off') };
    });
  }

  /** Copy an account's memory to a new file with VACUUM INTO, uncheckpointed WAL content included. For scripts; it blocks. */
  snapshot(account: string | undefined, path: string): void {
    this.loud(() => {
      const db = this.db(account, false);
      if (!db) throw new MemoryError(`no memory file for ${this.keyOf(account)}`);
      db.prepare('VACUUM INTO ?').run(path);
    });
  }

  close(): void {
    for (const t of this.checks.values()) if (t) clearImmediate(t);
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
  }

  // --- Internals ---

  private keyOf(account: string | undefined): string {
    return accountKey(account === undefined ? [] : claudeAccounts(this.home), account);
  }

  private fileOf(key: string): string {
    return join(this.home, 'memory', `${key}.db`);
  }

  private existingKeys(): string[] {
    try {
      return readdirSync(join(this.home, 'memory')).flatMap((f) => /^([^.]+)\.db$/.exec(f)?.[1] ?? []);
    } catch {
      return [];
    }
  }

  /** Manager-facing: never throws; logs once per account and reason. */
  private quiet<T>(account: string | undefined, fallback: T, fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      this.report(account ?? '', err);
      return fallback;
    }
  }

  private report(key: string, err: unknown): void {
    const reason = (err as Error)?.message ?? String(err);
    if (this.logged.has(`${key}\0${reason}`)) return;
    this.logged.add(`${key}\0${reason}`);
    this.log(new Error(`memory${key ? ` (${key})` : ''}: ${reason}`));
  }

  /** Tool-facing: MemoryError as written, anything else as "memory is unavailable: <reason>". */
  private loud<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof MemoryError) throw err;
      throw new Error(`memory is unavailable: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  private db(account: string | undefined, create: boolean): DatabaseSync | undefined {
    return this.handle(this.keyOf(account), create);
  }

  /**
   * The account file's open handle, opening it on first use. undefined when the file does not exist and create is false:
   * only writes create one. A corrupt file is renamed aside and, for a write, replaced by a new one.
   */
  private handle(key: string, create: boolean): DatabaseSync | undefined {
    const open = this.dbs.get(key);
    if (open) return open;
    if (this.off) throw new Unavailable(this.off);
    const down = this.down.get(key);
    if (down && (down.state === 'off' || Date.now() - down.at < LIMITS.store.retryBrokenMs)) throw new Unavailable(down.reason);
    const file = this.fileOf(key);
    if (!create && !existsSync(file)) return undefined;
    const sqlite = this.load();
    let db: DatabaseSync;
    try {
      db = this.openFile(sqlite, file, create);
    } catch (err) {
      if (err instanceof Unavailable) {
        this.down.set(key, { state: 'off', reason: err.message, at: Date.now() });
        throw err;
      }
      if (errcode(err) === 5 || errcode(err) === 6) throw err; // locked: skip this operation only
      if (errcode(err) !== 11 && errcode(err) !== 26) {
        this.down.set(key, { state: 'broken', reason: (err as Error).message, at: Date.now() });
        throw err;
      }
      const aside = this.quarantine(key);
      this.report(key, new Error(`${file} is corrupt (${(err as Error).message}); moved it to ${aside}`));
      if (!create) return undefined;
      db = this.openFile(sqlite, file, true);
    }
    this.down.delete(key);
    this.dbs.set(key, db);
    if (!this.checks.has(key)) { // check point (a): the size limit once after the first open, not inline
      const t = setImmediate(() => { this.checks.set(key, undefined); void this.enforce(key, this.maxMB()); });
      this.checks.set(key, t);
    }
    return db;
  }

  /** node:sqlite, loaded on the first open; FTS5 probed once in memory. Either missing turns memory off for this process. */
  private load(): typeof import('node:sqlite') {
    if (this.sqlite) return this.sqlite;
    const sqlite = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined;
    if (!sqlite) throw new Unavailable(this.off = 'this Node has no node:sqlite');
    try {
      const probe = new sqlite.DatabaseSync(':memory:');
      try { probe.exec('CREATE VIRTUAL TABLE temp.fts_probe USING fts5(x)'); } finally { probe.close(); }
    } catch {
      throw new Unavailable(this.off = 'no FTS5');
    }
    return (this.sqlite = sqlite);
  }

  private openFile(sqlite: typeof import('node:sqlite'), file: string, create: boolean): DatabaseSync {
    if (create && !existsSync(file)) {
      mkdirSync(join(this.home, 'memory'), { recursive: true, mode: 0o700 });
      closeSync(openSync(file, 'a', 0o600)); // SQLite gives its -wal and -shm files the database file's mode
    }
    const db = new sqlite.DatabaseSync(file, { timeout: LIMITS.store.lockTimeoutMs });
    try {
      const version = pragma(db, 'user_version'); // the first statement: a corrupt file throws here
      if (version > SCHEMA_VERSION) throw new Unavailable(`written by a newer tiller (schema ${version})`);
      db.exec('PRAGMA secure_delete = ON; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON');
      if (version === 0) db.exec(SCHEMA_V1);
      return db;
    } catch (err) {
      db.close();
      throw err;
    }
  }

  /** Rename <key>.db and its -wal and -shm to <key>.corrupt-<ts>.db*, never deleting them; returns the new path. */
  private quarantine(key: string): string {
    const file = this.fileOf(key), aside = join(this.home, 'memory', `${key}.corrupt-${Date.now()}.db`);
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) renameSync(file + suffix, aside + suffix);
    return aside;
  }

  private maxMB(): number {
    try {
      return loadConfig(null, this.home).memory.maxMB;
    } catch {
      return LIMITS.size.defaultMB;
    }
  }

  private repo(db: DatabaseSync, scope: MemoryScope, create: boolean): number | undefined {
    const row = db.prepare('SELECT id FROM repos WHERE key = ?').get(scope.repoKey) as { id: number } | undefined;
    if (row || !create) return row?.id;
    return Number((db.prepare('INSERT INTO repos (key, path, created_at) VALUES (?, ?, ?) RETURNING id')
      .get(scope.repoKey, scope.repoPath, this.now()) as { id: number }).id);
  }

  /** The repo's item; another repo's, or none, is "no such item". */
  private item(db: DatabaseSync, repo: number, id: number): ItemRow {
    const row = db.prepare('SELECT * FROM items WHERE id = ? AND repo_id = ?').get(id, repo) as ItemRow | undefined;
    if (!row) throw new MemoryError(`no such item ${itemRef(id)}`);
    return row;
  }

  private episode(db: DatabaseSync, repo: number, scope: MemoryScope, e: EpisodeInput): number {
    return Number((db.prepare(`INSERT INTO episodes (ts, repo_id, root_id, node_id, kind, harness, model, role, profile, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(
      e.ts, repo, scope.rootId ?? scope.nodeId ?? '', scope.nodeId ?? '', e.kind,
      scope.harness ?? null, scope.model ?? null, scope.role ?? null, scope.profile ?? null, JSON.stringify(e.data),
    ) as { id: number }).id);
  }

  /** Bump a live item, revive an agent-retracted or evicted one with the new text, skip a human-retracted one, else insert. */
  private upsert(db: DatabaseSync, it: {
    repo_id: number; kind: ItemKind; text: string; body: string; author: string; dedupe: string; node_id: string | null;
    root_id: string | null; harness: string | null; model: string | null; episode_id: number | null; now: number;
  }): AddResult | { sticky: number } {
    const row = db.prepare('SELECT id, invalid_kind FROM items WHERE repo_id = ? AND kind = ? AND dedupe = ?')
      .get(it.repo_id, it.kind, it.dedupe) as { id: number; invalid_kind: string | null } | undefined;
    if (!row) {
      const { now, ...cols } = it;
      const id = db.prepare(`INSERT INTO items (repo_id, kind, text, body, author, dedupe, node_id, root_id, harness, model, episode_id, created_at, updated_at)
        VALUES (:repo_id, :kind, :text, :body, :author, :dedupe, :node_id, :root_id, :harness, :model, :episode_id, :now, :now) RETURNING id`)
        .get({ ...cols, now }) as { id: number };
      return { id: Number(id.id) };
    }
    if (row.invalid_kind === 'human' || row.invalid_kind === 'superseded') return { sticky: row.id };
    const revived = row.invalid_kind !== null;
    db.prepare(`UPDATE items SET seen = seen + 1, updated_at = :now${revived
      ? ', text = :text, body = :body, invalid_at = NULL, invalid_kind = NULL, invalid_by = NULL, invalid_reason = NULL' : ''} WHERE id = :id`)
      .run({ now: it.now, id: row.id, ...(revived ? { text: it.text, body: it.body } : {}) });
    return revived ? { id: row.id, revived: true } : { id: row.id, existing: true };
  }

  private invalidate(db: DatabaseSync, id: number, kind: 'agent' | 'human' | 'superseded', by: string, reason: string): void {
    db.prepare('UPDATE items SET invalid_at = ?, invalid_kind = ?, invalid_by = ?, invalid_reason = ? WHERE id = ?').run(this.now(), kind, by, reason, id);
  }

  private cap(db: DatabaseSync, nodeId: string, kind: 'add' | 'forget', max: number, tool: string): void {
    const n = Number((db.prepare('SELECT count(*) AS n FROM episodes WHERE node_id = ? AND kind = ?').get(nodeId, kind) as { n: number }).n);
    if (n >= max) throw new MemoryError(`${tool} is limited to ${max} per node`);
  }

  private who(actor: Actor) {
    return actor.kind === 'human'
      ? { actor: 'human', node_id: null, root_id: null, harness: null, model: null }
      : { actor: actor.nodeId, node_id: actor.nodeId, root_id: actor.rootId, harness: actor.harness ?? null, model: actor.model ?? null };
  }

  /** The node columns of an actor's own episode: the agent's node, or 'human'. */
  private episodeScope(actor: Actor): Partial<MemoryScope> {
    return actor.kind === 'human'
      ? { nodeId: 'human', rootId: 'human', harness: undefined, model: undefined, role: undefined, profile: undefined }
      : { nodeId: actor.nodeId, rootId: actor.rootId, harness: actor.harness, model: actor.model };
  }

  /**
   * Tombstone the item and every item of its episode, cut that episode and the node's gate runs before it (since the
   * previous outcome) to their skeletons, and blank every injection that named one of the items. Runs in the caller's
   * transaction; scrub() then removes the bytes.
   */
  private purge(db: DatabaseSync, item: ItemRow, reason: string): void {
    const ids = item.episode_id === null ? [item.id]
      : (db.prepare('SELECT id FROM items WHERE episode_id = ? OR id = ?').all(item.episode_id, item.id) as { id: number }[]).map((r) => Number(r.id));
    db.prepare(`UPDATE items SET text = '', body = '', dedupe = 'purged:' || id, invalid_at = :now, invalid_kind = 'human',
      invalid_by = 'human', invalid_reason = :reason WHERE id IN (SELECT value FROM json_each(:ids))`).run({ now: this.now(), reason, ids: JSON.stringify(ids) });
    const ep = item.episode_id === null ? undefined
      : db.prepare('SELECT id, node_id, kind, data FROM episodes WHERE id = ?').get(item.episode_id) as { id: number; node_id: string; kind: string; data: string } | undefined;
    if (ep) {
      const since = Number((db.prepare(`SELECT coalesce(max(id), 0) AS id FROM episodes WHERE node_id = ? AND kind = 'outcome' AND id < ?`)
        .get(ep.node_id, ep.id) as { id: number }).id);
      const gates = db.prepare(`SELECT id, kind, data FROM episodes WHERE node_id = ? AND kind = 'gate' AND id > ? AND id < ?`)
        .all(ep.node_id, since, ep.id) as { id: number; kind: string; data: string }[];
      const set = db.prepare('UPDATE episodes SET data = ? WHERE id = ?');
      for (const e of [ep, ...gates]) set.run(JSON.stringify(skeleton(e.kind, JSON.parse(e.data))), e.id);
    }
    db.prepare(`UPDATE injections SET text = '' WHERE text <> '' AND EXISTS (SELECT 1 FROM json_each(item_ids) WHERE value IN (SELECT value FROM json_each(?)))`)
      .run(JSON.stringify(ids));
  }

  /**
   * Remove purged bytes: secure_delete zeroed the freed cells; optimize rewrites FTS segments that still hold the old
   * tokens; the checkpoints and incremental_vacuum empty the WAL and drop freed pages. One blocking pass, for a rare human action.
   */
  private scrub(db: DatabaseSync): void {
    db.exec(`INSERT INTO items_fts(items_fts) VALUES ('optimize')`);
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    for (let left = pragma(db, 'freelist_count'), was = Infinity; left > 0 && left < was; was = left, left = pragma(db, 'freelist_count')) {
      db.exec(`PRAGMA incremental_vacuum(${LIMITS.size.vacuumPages})`);
    }
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  }

  private statusOf(key: string): MemoryDbStatus {
    const path = this.fileOf(key);
    let quarantined: string[] = [];
    try {
      quarantined = readdirSync(join(this.home, 'memory')).filter((f) => f.startsWith(`${key}.corrupt-`) && f.endsWith('.db')).map((f) => join(this.home, 'memory', f));
    } catch { /* no dir yet */ }
    const base = { key, path, quarantined };
    let db: DatabaseSync | undefined;
    try {
      db = this.handle(key, false);
    } catch (err) {
      const down = this.down.get(key);
      return { ...base, state: `${down?.state ?? (this.off ? 'off' : 'broken')}: ${(err as Error).message}` };
    }
    if (!db) return { ...base, state: 'missing' };
    try {
      const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
      const items = Object.fromEntries(ITEM_KINDS.map((k) => [k, 0])) as Record<ItemKind, number>;
      for (const r of db.prepare('SELECT kind, count(*) AS n FROM items WHERE invalid_at IS NULL GROUP BY kind').all() as { kind: ItemKind; n: number }[]) items[r.kind] = Number(r.n);
      const size = (f: string) => { try { return statSync(f).size; } catch { return 0; } };
      return {
        ...base, state: 'ok', schema: pragma(db, 'user_version'), sizeBytes: size(path) + size(`${path}-wal`), usedBytes: used(db),
        ...(this.overLimit.has(key) ? { overLimit: true } : {}),
        counts: {
          items, retracted: count('SELECT count(*) AS n FROM items WHERE invalid_at IS NOT NULL'),
          tombstones: count(`SELECT count(*) AS n FROM items WHERE text = ''`), pinned: count('SELECT count(*) AS n FROM items WHERE pinned = 1 AND invalid_at IS NULL'),
          episodes: count('SELECT count(*) AS n FROM episodes'), injections: count('SELECT count(*) AS n FROM injections'),
        },
      };
    } catch (err) {
      return { ...base, state: `broken: ${(err as Error).message}` };
    }
  }

  private async enforce(key: string, maxMB: number): Promise<void> {
    if (this.enforcing.has(key)) return;
    this.enforcing.add(key);
    try {
      const db = this.handle(key, false);
      if (!db) return;
      const limit = maxMB * MB, target = limit * LIMITS.size.target;
      if (used(db) <= limit) {
        this.overLimit.delete(key);
        return;
      }
      const live = () => this.dbs.get(key) === db; // close() may run while we yield
      for (const step of this.evictions(db)) {
        while (live() && used(db) > target && step()) await tick();
      }
      if (!live()) return;
      for (let i = 0; i < LIMITS.size.ftsMergeSteps && live(); i++, await tick()) {
        db.prepare(`INSERT INTO items_fts(items_fts, rank) VALUES ('merge', ?)`).run(LIMITS.size.ftsMergePages);
      }
      for (let left = live() ? pragma(db, 'freelist_count') : 0, was = Infinity; live() && left > 0 && left < was; was = left, left = pragma(db, 'freelist_count')) {
        db.exec(`PRAGMA incremental_vacuum(${LIMITS.size.vacuumPages})`);
        await tick();
      }
      if (!live()) return;
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (used(db) > limit) {
        this.overLimit.add(key);
        this.report(key, new Error(`over memory.maxMB (${maxMB}) after eviction`));
      } else {
        this.overLimit.delete(key);
      }
    } catch (err) {
      this.report(key, err);
    } finally {
      this.enforcing.delete(key);
    }
  }

  /**
   * The eviction steps in order, each one batch per call returning whether it changed anything. Only content older than
   * LIMITS.size.evictAfterDays goes, and never a pinned item; procedures, pitfalls and notes are kept.
   */
  private evictions(db: DatabaseSync): (() => boolean)[] {
    const cut = this.now() - LIMITS.size.evictAfterDays * DAY, batch = LIMITS.size.batchRows, now = this.now();
    const rows = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as Record<string, SQLInputValue>[];
    let cursor = 0;
    return [
      // 1. Injection texts: their freezes then inject nothing on resume.
      () => {
        const batchRows = rows(`SELECT * FROM injections WHERE text <> '' AND ts < ? ORDER BY ts, id LIMIT ${batch}`, cut);
        rewrite(db, 'injections', batchRows.map((r) => ({ ...r, text: '' })));
        return batchRows.length > 0;
      },
      // 2. Episodes to their metric skeletons.
      () => {
        const batchRows = rows(`SELECT * FROM episodes WHERE ts < ? AND id > ? ORDER BY id LIMIT ${batch}`, cut, cursor);
        if (batchRows.length === 0) return false;
        cursor = Number(batchRows.at(-1)!.id);
        rewrite(db, 'episodes', batchRows.flatMap((r) => {
          const data = JSON.stringify(skeleton(String(r.kind), JSON.parse(String(r.data))));
          return data === r.data ? [] : [{ ...r, data }];
        }));
        return true;
      },
      // 3. Retracted items to tombstones: the row, dedupe and invalid_* stay, so a human retraction stays sticky.
      () => {
        const batchRows = rows(`SELECT * FROM items WHERE invalid_at IS NOT NULL AND invalid_at < ? AND pinned = 0
          AND (text <> '' OR body <> '') ORDER BY invalid_at, id LIMIT ${batch}`, cut);
        rewrite(db, 'items', batchRows.map((r) => ({ ...r, text: '', body: '' })));
        return batchRows.length > 0;
      },
      // 4. Valid ledger items and open questions, least used and oldest first.
      () => {
        const batchRows = rows(`SELECT * FROM items WHERE invalid_at IS NULL AND kind IN ('ledger', 'open_question') AND updated_at < ?
          AND pinned = 0 ORDER BY cites + gets, updated_at, id LIMIT ${batch}`, cut);
        rewrite(db, 'items', batchRows.map((r) => ({
          ...r, text: '', body: '', invalid_at: now, invalid_kind: 'evicted', invalid_by: 'daemon', invalid_reason: 'memory.maxMB',
        })));
        return batchRows.length > 0;
      },
    ];
  }

  private armStats(db: DatabaseSync, firsts: InjectionRow[]): ArmStats {
    const ratio = (n: number, d: number) => (d ? n / d : null);
    const s = { gated: 0, firstPass: 0, reported: 0, failed: 0, succeeded: 0, successRuns: 0, closed: 0, spent: 0, spentN: 0, wall: 0,
      sends: 0, injected: 0, cites: 0, forgets: 0, repeats: 0, repeatsInjected: 0 };
    for (const inj of firsts) {
      const injected = new Set(JSON.parse(inj.item_ids) as number[]);
      s.injected += injected.size;
      const eps = (db.prepare('SELECT kind, data FROM episodes WHERE node_id = ? ORDER BY ts, id').all(inj.node_id) as { kind: EpisodeKind; data: string }[])
        .map((e) => ({ kind: e.kind, data: JSON.parse(e.data) as Record<string, unknown> }));
      const gates = eps.filter((e) => e.kind === 'gate'), outcome = eps.filter((e) => e.kind === 'outcome').at(-1), close = eps.find((e) => e.kind === 'close');
      if (gates.length) { s.gated++; if (gates[0].data.ok) s.firstPass++; }
      if (outcome) {
        s.reported++;
        if (outcome.data.outcome === 'failed') s.failed++;
        else { s.succeeded++; s.successRuns += gates.length; }
      }
      if (close) {
        s.closed++;
        s.wall += Number(close.data.closedAt) - Number(close.data.createdAt);
        if (typeof close.data.spentUsd === 'number') { s.spent += close.data.spentUsd; s.spentN++; }
      }
      s.sends += eps.filter((e) => e.kind === 'human_send').length;
      for (const e of eps.filter((x) => x.kind === 'outcome')) {
        for (const [, id] of JSON.stringify(e.data).matchAll(/\[m(\d+)\]/g)) if (injected.has(Number(id))) s.cites++;
      }
      s.forgets += eps.filter((e) => e.kind === 'forget' && injected.has(Number(e.data.itemId))).length;
      // prune: a repeat is a failed run whose first error line appears in an earlier pitfall's dedupe key; skeletons lose the tail after eviction.
      for (const g of gates.filter((x) => !x.data.ok && typeof x.data.tail === 'string')) {
        const line = firstErrorLine(String(g.data.tail));
        if (!line) continue;
        const hit = db.prepare(`SELECT id FROM items WHERE repo_id = ? AND kind = 'pitfall' AND created_at <= ? AND instr(dedupe, ?) > 0 LIMIT 1`)
          .get(inj.repo_id, inj.ts, normalizeDedupe('pitfall', line)) as { id: number } | undefined;
        if (hit) { s.repeats++; if (injected.has(Number(hit.id))) s.repeatsInjected++; }
      }
    }
    return {
      nodes: firsts.length, firstPassGate: ratio(s.firstPass, s.gated), failedOutcomes: ratio(s.failed, s.reported),
      gateRunsPerSuccess: ratio(s.successRuns, s.succeeded), spentUsd: ratio(s.spent, s.spentN), wallMs: ratio(s.wall, s.closed),
      humanSendsPerNode: ratio(s.sends, firsts.length), injectedItems: s.injected, citesPerInjected: ratio(s.cites, s.injected),
      forgetsOfInjected: s.forgets, repeatedPitfalls: s.repeats, repeatedInjectedPitfalls: s.repeatsInjected,
    };
  }
}
