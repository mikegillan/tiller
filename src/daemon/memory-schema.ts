// The contract of daemon-native memory: its SQLite schema, row and IO types, limits, MCP tool shapes and the pure
// helpers every memory module shares. The store, derive, digest and opt-in modules implement against it.
import { z } from 'zod';
import type { ArchivedNode, Harness, NodeKind, Outcome, Profile, Role, SendOutcome } from '../shared/protocol.js';
import type { ClaudeAccount } from './claude-accounts.js';
import type { MergeStyle } from './config.js';

/**
 * Schema version 1. Kinds, authors and lengths have no CHECK: they are enforced in TS and zod (ITEM_KINDS, LIMITS), so a
 * new kind needs no table rebuild. Run it with exec() on a new file before anything else, outside a transaction:
 * auto_vacuum only holds when set before the first table, and journal_mode cannot change inside a transaction.
 */
export const SCHEMA_V1 = `
PRAGMA auto_vacuum = INCREMENTAL;     -- must precede the first CREATE TABLE (else silently 0)
PRAGMA journal_mode = WAL;            -- on every open also: synchronous=NORMAL, foreign_keys=ON
CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,           -- 'git:github.com/swicken/tiller' | 'path:/abs' | 'account:' (sentinel)
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
INSERT INTO repos (key, path, created_at) VALUES ('account:', '', 0);   -- reserved account-wide scope; v1 never uses it
CREATE TABLE episodes (               -- append-only facts: derive() input, provenance, metrics
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  root_id TEXT NOT NULL, node_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- EPISODE_KINDS in TS
  harness TEXT, model TEXT, role TEXT, profile TEXT,
  data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data))   -- redacted, capped
) STRICT;
CREATE INDEX episodes_repo_ts ON episodes(repo_id, ts);
CREATE INDEX episodes_node ON episodes(node_id, ts);
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,   -- m<id>; never reused
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  kind TEXT NOT NULL,                     -- ITEM_KINDS
  text TEXT NOT NULL,                     -- '' only for tombstones
  body TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL,                   -- AUTHORS: daemon | agent | human
  node_id TEXT, root_id TEXT, harness TEXT, model TEXT,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
  dedupe TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  invalid_at INTEGER, invalid_kind TEXT,  -- agent (forget or supersede by an agent) | human | superseded (by the human only) | evicted
  invalid_by TEXT, invalid_reason TEXT,
  supersedes INTEGER REFERENCES items(id),
  cites INTEGER NOT NULL DEFAULT 0, gets INTEGER NOT NULL DEFAULT 0,
  UNIQUE (repo_id, kind, dedupe)
) STRICT;
CREATE INDEX items_repo_kind ON items(repo_id, kind, updated_at) WHERE invalid_at IS NULL;
CREATE INDEX items_root ON items(root_id, kind, updated_at) WHERE invalid_at IS NULL;
CREATE VIRTUAL TABLE items_fts USING fts5(text, body, content='items', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, text, body) VALUES (new.id, new.text, new.body); END;
CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, text, body) VALUES ('delete', old.id, old.text, old.body); END;
CREATE TRIGGER items_au AFTER UPDATE OF text, body ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, text, body) VALUES ('delete', old.id, old.text, old.body);
  INSERT INTO items_fts(rowid, text, body) VALUES (new.id, new.text, new.body); END;
CREATE TABLE injections (             -- one row per launch that applied a digest decision
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL, node_id TEXT NOT NULL, root_id TEXT NOT NULL,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  arm TEXT NOT NULL,                  -- on | off (applied)
  cause TEXT NOT NULL,                -- config | ab | resume
  role TEXT, profile TEXT, harness TEXT, model TEXT,
  item_ids TEXT NOT NULL CHECK (json_valid(item_ids)),
  text TEXT NOT NULL                  -- '' on resume rows, scrubbed or evicted rows
) STRICT;
CREATE INDEX injections_session ON injections(session_id, ts);
CREATE INDEX injections_node ON injections(node_id, ts);
PRAGMA user_version = 1;
`;
export const SCHEMA_VERSION = 1;

/**
 * A text pin (memory_pin { text }) is a human `note` with pinned = 1 and its own dedupe key (pinDedupe), so it never merges
 * into an agent's note. Pinning by id (memory_pin { id }) sets pinned = 1 on that row, whoever wrote it: the human's
 * explicit choice. Pinned items of any kind render only as pins.
 */
export const ITEM_KINDS = ['ledger', 'open_question', 'procedure', 'pitfall', 'note'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
/** The kinds an agent or the human may record with memory_add. */
export const ADD_KINDS = ['procedure', 'pitfall', 'note'] as const satisfies readonly ItemKind[];
export const EPISODE_KINDS = ['spawn', 'outcome', 'gate', 'merge', 'close', 'human_send', 'add', 'forget', 'pin'] as const;
/** daemon: text made solely of daemon facts. agent: anything an agent wrote, gate output included. human: the human's. */
export const AUTHORS = ['daemon', 'agent', 'human'] as const;
export type Author = (typeof AUTHORS)[number];
/**
 * Why an item is hidden. agent: an agent's forget or supersede, undone when later work derives it again. human and
 * superseded (the human's supersede): sticky. evicted: tombstoned by the size limit.
 */
export const INVALID_KINDS = ['agent', 'human', 'superseded', 'evicted'] as const;
export type InvalidKind = (typeof INVALID_KINDS)[number];
/** The digest arm a launch applied, and why: memory.digest on/off, the ab split, or a resume reusing its frozen text. */
export const ARMS = ['on', 'off'] as const;
export type Arm = (typeof ARMS)[number];
export const CAUSES = ['config', 'ab', 'resume'] as const;
export type Cause = (typeof CAUSES)[number];
export const DIGEST_ROLES = ['orchestrator', 'worker', 'reviewer'] as const;
/** Which digest a node gets: reviewer covers the reviewer and explorer profiles. */
export type DigestRole = (typeof DIGEST_ROLES)[number];

/** Every cap and budget. Characters unless named otherwise; a token is about 4 characters. */
export const LIMITS = {
  item: {
    text: 300,
    body: 2_000,
    /** A ledger item's body, and the brief excerpt at its head. */
    ledgerBody: 4_000,
    ledgerBrief: 500,
    /** A node's title in a ledger line. */
    title: 80,
  },
  outcome: {
    openQuestions: 10,
    openQuestion: 300,
    /** An outcome episode's serialized data. */
    episode: 6_000,
  },
  /** A failed gate's tail kept in its episode, cut from the front so the daemon's exit line stays last. */
  gateTail: 2_000,
  procedure: {
    span: 200,
    /** Recency weighting of seen: halves every this many days of age since updated_at. */
    halfLifeDays: 30,
  },
  perNode: { adds: 20, forgets: 20 },
  tools: {
    query: 500,
    reason: 300,
    pinText: 500,
    search: { default: 8, max: 20 },
    statusDays: { default: 14, max: 365 },
  },
  candidates: { pins: 20, ledger: 8, openQuestions: 10, openQuestionDays: 7, procedures: 10, pitfalls: 10, notes: 10, matched: 30 },
  digest: {
    line: 300,
    pinned: 1_200,
    budget: { orchestrator: 6_000, worker: 2_400, reviewer: 1_800 } satisfies Record<DigestRole, number>,
    /** Items per section after Pinned, by digest role, in render order. */
    orchestrator: { recent: 8, raised: 5, verification: 5, pitfalls: 3, notes: 3 },
    worker: { procedures: 3 },
    reviewer: { verification: 3 },
    /** k in the worker's RRF over bm25 and recency ranks. */
    rrfK: 60,
    ftsTerms: 32,
  },
  store: { lockTimeoutMs: 100, retryBrokenMs: 60_000 },
  size: {
    defaultMB: 200,
    minMB: 16,
    /** Enforcement cuts down to this fraction of maxMB. */
    target: 0.9,
    batchRows: 500,
    evictAfterDays: 30,
    vacuumPages: 256,
    ftsMergePages: 200,
    /** The plan says "a few bounded steps"; tune in the store if merges prove slow. */
    ftsMergeSteps: 4,
  },
} as const;

/** The data of each episode kind. harness, model, role and profile are columns, taken from the MemoryScope. */
export interface EpisodeData {
  spawn: { parentId: string | null; kind: NodeKind; branch?: string; preset?: string };
  outcome: Omit<Outcome, 'at'>;
  /** tail only on failure, ≤ LIMITS.gateTail. */
  gate: { ok: boolean; command: string; attempt: number; tail?: string };
  merge: { branch: string; base: string; sha: string; style: MergeStyle };
  close: {
    spentUsd?: number; createdAt: number; closedAt: number; branchFate?: ArchivedNode['branchFate'];
    base?: string; outcome?: Outcome['outcome']; gate?: Outcome['gate'];
  };
  human_send: { messageId: string; outcome: SendOutcome };
  /** actor: the node id, or 'human'. */
  add: { itemId: number; actor: string };
  forget: { itemId: number; actor: string; reason: string };
  pin: { itemId: number; unpin?: boolean };
}
export type EpisodeKind = keyof EpisodeData;
// EPISODE_KINDS lists exactly the keys of EpisodeData.
const episodeKindsMatch: [EpisodeKind, (typeof EPISODE_KINDS)[number]] extends [(typeof EPISODE_KINDS)[number], EpisodeKind] ? true : never = true;
void episodeKindsMatch;

/** What eviction keeps of an old episode's data: its metric fields; every other kind keeps {}. */
export interface EpisodeSkeleton {
  outcome: Pick<EpisodeData['outcome'], 'outcome' | 'gate'>;
  gate: Pick<EpisodeData['gate'], 'ok' | 'command'>;
  close: Pick<EpisodeData['close'], 'spentUsd' | 'createdAt' | 'closedAt' | 'branchFate' | 'outcome' | 'gate'>;
}

/** One element of derive()'s history and of nodeHistory()'s result. */
export type HistoryEntry = { [K in EpisodeKind]: { kind: K; ts: number; data: EpisodeData[K] } }[EpisodeKind];
/** An episode to append; its repo, root, node, harness, model, role and profile come from the MemoryScope. */
export type EpisodeInput = HistoryEntry;

/**
 * What the daemon captures, at its call sites only (see captureMemory). derive() is pure over it: time comes from ts.
 * gate.tail is the gate's whole tail on failure (derive caps it); close carries the node's archive line, title and prompt included.
 */
export type CaptureEvent =
  | ({ type: 'spawn'; ts: number } & EpisodeData['spawn'])
  | ({ type: 'outcome'; ts: number } & EpisodeData['outcome'])
  | ({ type: 'gate'; ts: number } & EpisodeData['gate'])
  | ({ type: 'merge'; ts: number } & EpisodeData['merge'])
  | { type: 'close'; ts: number; archived: ArchivedNode }
  | ({ type: 'human_send'; ts: number } & EpisodeData['human_send']);

/** An item derive() produces; node, root, harness and model come from the MemoryScope. derive never writes human items. */
export interface DerivedItem {
  kind: ItemKind;
  text: string;
  body?: string;
  author: Exclude<Author, 'human'>;
  /** normalizeDedupe of the redacted text, or the kind's own key (a ledger item's is the node id). */
  dedupe: string;
}
/** derive()'s result: the episode to append, its items, and the item ids its text cited as [m<id>]. */
export interface Derived { episode: EpisodeInput; items: DerivedItem[]; cites: number[] }

/** Where a memory operation applies. account: the node's (undefined: none). The node fields are absent for the human. */
export interface MemoryScope {
  account?: string;
  /** 'git:' + normalizeRemote(origin), else 'path:' + the main checkout's real path. */
  repoKey: string;
  repoPath: string;
  nodeId?: string;
  rootId?: string;
  harness?: Harness;
  model?: string;
  role?: Role;
  profile?: Profile;
}

/** Who calls add, forget or pin. An agent's eligibility comes from its newest outcome episode. */
export type Actor = { kind: 'human' } | { kind: 'agent'; nodeId: string; rootId: string; harness?: Harness; model?: string };

/** A row of items as SELECT * returns it. */
export interface ItemRow {
  id: number;
  repo_id: number;
  kind: ItemKind;
  text: string;
  body: string;
  author: Author;
  node_id: string | null;
  root_id: string | null;
  harness: string | null;
  model: string | null;
  episode_id: number | null;
  dedupe: string;
  seen: number;
  pinned: 0 | 1;
  created_at: number;
  updated_at: number;
  invalid_at: number | null;
  invalid_kind: InvalidKind | null;
  invalid_by: string | null;
  invalid_reason: string | null;
  supersedes: number | null;
  cites: number;
  gets: number;
}

/** An item as tools and the digest see it. body is present from get only. */
export interface ItemView {
  id: number;
  kind: ItemKind;
  text: string;
  body?: string;
  author: Author;
  nodeId?: string;
  rootId?: string;
  harness?: string;
  model?: string;
  seen: number;
  pinned: boolean;
  cites: number;
  gets: number;
  createdAt: number;
  updatedAt: number;
  supersedes?: number;
  invalid?: { at: number; kind: InvalidKind; by?: string; reason?: string };
  /** Set when text is '': evicted by the size limit, or purged by the human. */
  tombstone?: 'evicted' | 'purged';
}

/** A row of injections as SELECT * returns it. item_ids is a JSON array of item ids. */
export interface InjectionRow {
  id: number;
  ts: number;
  session_id: string;
  node_id: string;
  root_id: string;
  repo_id: number;
  arm: Arm;
  cause: Cause;
  role: string | null;
  profile: string | null;
  harness: string | null;
  model: string | null;
  item_ids: string;
  text: string;
}
/** One injection in memory_status { nodeId }'s data.injections, oldest first. */
export interface InjectionView { sessionId: string; arm: Arm; cause: Cause; itemIds: number[]; text: string; ts: number }

/** The digest's candidates, eligible and valid only, each list in its ranked order (matched: bm25 order; workers only). */
export interface DigestCandidates {
  pins: ItemView[];
  ledger: ItemView[];
  openQuestions: ItemView[];
  procedures: ItemView[];
  pitfalls: ItemView[];
  notes: ItemView[];
  matched: ItemView[];
}
/**
 * What digestFor reads; MemoryStore implements it. terms come from ftsTerms(brief). now is the caller's clock (digestFor
 * passes its own): the open-question window and procedure recency are measured from it, not from the store's.
 */
export interface DigestSource { candidates(scope: MemoryScope, q: { role: DigestRole; terms: string[]; now: number }): DigestCandidates }
export interface DigestInput { role: DigestRole; brief?: string; now: number }
/** text is '' when nothing was selected. */
export interface DigestResult { text: string; itemIds: number[] }

const REF = /^m([1-9]\d{0,15})$/;
export const itemRef = (id: number): string => `m${id}`;
/** The id an `m<id>` ref names; undefined for anything else, or an id past the safe integer range. */
export function parseItemRef(ref: string): number | undefined {
  const m = REF.exec(ref);
  const id = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(id) ? id : undefined;
}

const ref = z.string().regex(REF, 'an item id like m12');
/** repo (a path) and account pick the scope; for the human only, as spawn's account is. */
const humanScope = { repo: z.string().min(1).optional(), account: z.string().min(1).optional() };
/**
 * Input shapes of the memory tools. memory_pin, memory_status and memory_switch are humanOnly. Rules a raw shape cannot
 * state are the handlers': memory_pin takes exactly one of id and text; memory_switch refuses account with project.
 */
export const MEMORY_TOOL_SHAPES = {
  memory_search: {
    query: z.string().min(1).max(LIMITS.tools.query), kind: z.enum(ITEM_KINDS).optional(),
    limit: z.number().int().min(1).max(LIMITS.tools.search.max).optional(), includeRetracted: z.boolean().optional(), ...humanScope,
  },
  memory_get: { id: ref, ...humanScope },
  memory_add: {
    kind: z.enum(ADD_KINDS), text: z.string().min(1).max(LIMITS.item.text), body: z.string().max(LIMITS.item.body).optional(),
    supersedes: ref.optional(), ...humanScope,
  },
  memory_forget: { id: ref, reason: z.string().min(1).max(LIMITS.tools.reason), purge: z.boolean().optional(), ...humanScope },
  memory_pin: { id: ref.optional(), text: z.string().min(1).max(LIMITS.tools.pinText).optional(), unpin: z.boolean().optional(), ...humanScope },
  memory_status: {
    days: z.number().int().min(1).max(LIMITS.tools.statusDays.max).optional(), nodeId: z.string().min(1).optional(), account: z.string().min(1).optional(),
  },
  /** on: null means inherit (remove the setting). No account or project sets the global memory.enabled. */
  memory_switch: { on: z.boolean().nullable(), account: z.string().min(1).optional(), project: z.string().min(1).optional() },
} satisfies Record<`memory_${string}`, z.ZodRawShape>;

export const REDACTED = '[redacted]';
// prune: known secret formats only; an unknown format is stored as written until the human purges it.
const SECRET_PATTERNS: RegExp[] = [
  // A PEM private key, to its END line or, when cut off, to the end of the text.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, // Anthropic, OpenAI
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, // JWT
];

function redactString(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
  // URL userinfo: keep the user, drop the password.
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*):[^/\s@]+@/gi, `$1:${REDACTED}@`);
  // prune: a credential must look like one (a digit, a symbol or an inner capital), so "Basic understanding" stays prose.
  out = out.replace(/\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/-]{8,}=*)/gi, (all, scheme, gap, cred: string) =>
    (/[0-9._~+/=-]|.[A-Z]/.test(cred) ? `${scheme}${gap}${REDACTED}` : all));
  // key = value, key: value, "key": "value"; access_token and API_KEY included.
  return out.replace(/(password|secret|token|api[_-]?key)(["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}'"]+)/gi, `$1$2${REDACTED}`);
}

/** value with every string in it, however deep, cleared of known secret formats. Idempotent; object keys are kept. */
export function redact<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)])) as T;
  return value;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** The exit line runCommands appends to a failed gate's output (worktree.ts). */
const EXIT_LINE = /: (?:exited with \d+|stopped by \S+ \(time limit [\d.]+ minutes\))$/;

/** The daemon's own exit line, read from the tail's last non-empty line only; undefined when that is not one. */
export function gateExit(tail: string): string | undefined {
  const last = tail.trimEnd().split('\n').at(-1)?.trim();
  return last && EXIT_LINE.test(last) ? last : undefined;
}

/**
 * The line of a failed gate's output most likely to name the error: the first matching error|fail|✗|×|TS<digits>, else
 * the last non-empty output line. Never the daemon's exit line. It is gate output, so agent text.
 */
export function firstErrorLine(tail: string): string | undefined {
  const lines = tail.replace(ANSI, '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (gateExit(tail) !== undefined) lines.pop();
  // prune: keyword heuristic; parse per-tool formats if pitfalls show the wrong line.
  return lines.find((l) => /error|fail|✗|×|TS\d{4}/i.test(l)) ?? lines.at(-1);
}

/** The first structural error code in the tail (TS2345, E0308): one token that cannot carry an instruction. */
export const structuralCode = (tail: string): string | undefined => /\b[A-Z]{1,5}\d{3,5}\b/.exec(tail)?.[0];

/** An item's dedupe key: lowercase, whitespace collapsed, and for pitfalls each digit run as #. Pass redacted text. */
export function normalizeDedupe(kind: ItemKind, text: string): string {
  const key = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return kind === 'pitfall' ? key.replace(/\d+/g, '#') : key;
}

/**
 * A text pin's dedupe key. normalizeDedupe lowercases, so its keys never contain "PIN:": no agent text can produce this
 * key, and UNIQUE (repo_id, kind, dedupe) keeps a pin apart from an agent note with the same text.
 */
export const pinDedupe = (text: string): string => `PIN:${normalizeDedupe('note', text)}`;

/**
 * A git remote URL as one key: scheme, userinfo, a trailing / and .git removed, scp host:path as host/path, lowercased.
 * A local-path remote (absolute, or file://) is returned as its path, unchanged in case; resolve a relative one against
 * the checkout before calling. Prefix the result with 'git:'.
 */
export function normalizeRemote(url: string): string {
  const u = url.trim();
  const file = /^file:\/\//i.test(u) ? u.slice('file://'.length) : u;
  if (file.startsWith('/')) return file.replace(/\/+$/, '') || '/';
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(u);
  let rest = scheme ? u.slice(scheme[0].length) : u;
  const slash = rest.indexOf('/');
  const at = rest.lastIndexOf('@', slash < 0 ? undefined : slash);
  if (at >= 0) rest = rest.slice(at + 1);
  // scp form: a colon before any slash separates host and path.
  if (!scheme) rest = rest.replace(/^([^/:]+):\/*/, '$1/');
  return rest.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
}

const STOPWORDS = new Set(('a an and are as at be but by can do does for from has have if in into is it its me my no not of on or our '
  + 'should so than that the their them then there these they this to too use was we were what when where which while who why will with '
  + 'would you your all any also each how just more most only other some such very').split(' '));
/** Directory names and file extensions that nearly every code path shares, so they say nothing about which work is related (bench D-2). */
const CODE_STOPWORDS = new Set(('src lib test tests spec specs index dist js jsx mjs cjs ts tsx mts cts json md yml yaml toml txt css scss html '
  + 'py rs go sh').split(' '));
const TOKEN = /[\p{L}\p{N}_]+/gu;
const PATH = /[\p{L}\p{N}_-]+(?:[/.][\p{L}\p{N}_-]+)+/gu;

/**
 * Search terms from untrusted text (a node's brief, a tool query): path mentions (src/daemon/x.ts, messaging.ts) as
 * phrases of all their tokens, space-joined, so only that exact path matches one; then single tokens of 2+ letters,
 * digits or _, lowercased, without stopwords, code stopwords (src, test, ts...) or repeats, at most
 * LIMITS.digest.ftsTerms. A path's specific parts thus stay as tokens and its generic ones only inside the phrase. A
 * term holds only letters, digits, _ and single spaces, so quoting each one (and joining with OR) keeps every FTS5
 * operator out of a MATCH.
 */
export function ftsTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const [path] of text.toLowerCase().matchAll(PATH)) {
    const parts = path.match(TOKEN) ?? [];
    if (parts.length > 1 && (path.includes('/') || /[\p{L}\p{N}_-]{2,}\.\p{L}[\p{L}\p{N}]{0,4}$/u.test(path))) terms.add(parts.join(' '));
  }
  for (const [token] of text.toLowerCase().matchAll(TOKEN)) {
    if (token.length >= 2 && !STOPWORDS.has(token) && !CODE_STOPWORDS.has(token)) terms.add(token);
  }
  return [...terms].slice(0, LIMITS.digest.ftsTerms);
}

/** The memory file key of a node's account: the name, or _default for none or Claude's default home (no configDir). */
export const DEFAULT_ACCOUNT_KEY = '_default';
/**
 * accounts is claudeAccounts(home), which throws on an invalid list, so a named account fails closed. Throws for a
 * name not in the list. Account names cannot start with _, so _default never collides with one.
 */
export function accountKey(accounts: readonly Pick<ClaudeAccount, 'name' | 'configDir'>[], account: string | undefined): string {
  if (account === undefined) return DEFAULT_ACCOUNT_KEY;
  const a = accounts.find((x) => x.name === account);
  if (!a) throw new Error(`Claude account "${account}" is not configured (claude.accounts)`);
  return a.configDir ? a.name : DEFAULT_ACCOUNT_KEY;
}
