import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeDedupe, type Actor, type Derived, type DerivedItem, type EpisodeInput, type ItemKind, type MemoryScope,
} from './memory-schema.js';
import { DIGEST_SECTIONS, digestFor } from './memory-digest.js';
import { ftsQuery, MemoryStore, readFailure } from './memory-store.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);

let home: string;
let clock: number;
let logs: string[];
const stores: MemoryStore[] = [];
const open = (opts: { now?: () => number } = {}) => {
  const s = new MemoryStore(home, { now: () => clock, log: (err) => logs.push(typeof err === 'string' ? err : (err as Error).message), ...opts });
  stores.push(s);
  return s;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tl-'));
  clock = T0;
  logs = [];
});
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

const file = () => join(home, 'memory', '_default.db');
const scope = (nodeId = 'n-w1', rootId = 'n-r1', repoKey = 'git:example.com/a/b'): MemoryScope =>
  ({ repoKey, repoPath: '/repo', nodeId, rootId, harness: 'claude', model: 'claude-x' });
const human: Actor = { kind: 'human' };
const agent = (nodeId = 'n-w1', rootId = 'n-r1'): Actor => ({ kind: 'agent', nodeId, rootId, harness: 'claude', model: 'claude-x' });
const item = (kind: ItemKind, text: string, author: DerivedItem['author'] = 'agent', body?: string): DerivedItem =>
  ({ kind, text, author, dedupe: normalizeDedupe(kind, text), ...(body === undefined ? {} : { body }) });
const derived = (items: DerivedItem[], episode: EpisodeInput = { kind: 'spawn', ts: clock, data: { parentId: null, kind: 'claude' } }, cites: number[] = []): Derived =>
  ({ episode, items, cites });
const outcome = (outcome: 'succeeded' | 'failed', gate?: 'passed' | 'failed', ts = clock): EpisodeInput =>
  ({ kind: 'outcome', ts, data: { outcome, ...(gate ? { gate } : {}) } });
/** A raw handle on the account file, for checks the store does not expose. */
const raw = () => new DatabaseSync(file());
const row = (id: number) => { const db = raw(); try { return db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Record<string, unknown>; } finally { db.close(); } };

describe('account files', () => {
  it('maps no account and accounts without configDir to _default, others to their name', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ claude: { accounts: [{ name: 'work', configDir: '/tmp/work-claude' }, { name: 'plain' }] } }));
    const s = open();
    expect(s.accountFile(undefined)).toBe(join(home, 'memory', '_default.db'));
    expect(s.accountFile('plain')).toBe(join(home, 'memory', '_default.db'));
    expect(s.accountFile('work')).toBe(join(home, 'memory', 'work.db'));
    expect(() => s.accountFile('nobody')).toThrow(/not configured/);
  });

  it('fails closed for named accounts while claude.accounts is invalid', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ claude: { accounts: 'nope' } }));
    const s = open();
    expect(() => s.accountFile('work')).toThrow(/claude.accounts/);
    s.apply({ ...scope(), account: 'work' }, derived([item('note', 'a note')]));
    expect(existsSync(join(home, 'memory'))).toBe(false);
    expect(() => s.search({ ...scope(), account: 'work' }, { query: 'note' })).toThrow(/^memory is unavailable: .*claude.accounts/);
    expect(s.accountFile(undefined)).toBe(file()); // no account needs no list
  });
});

describe('upsert and retraction', () => {
  it('bumps seen on a repeat with no burned ids', () => {
    const s = open();
    for (let i = 0; i < 3; i++) s.apply(scope(), derived([item('pitfall', 'gate `npm test` failed: boom 12')]));
    s.apply(scope(), derived([item('pitfall', 'gate `npm test` failed: other')]));
    expect(row(1)).toMatchObject({ seen: 3, kind: 'pitfall' });
    expect(row(2)).toMatchObject({ seen: 1, text: 'gate `npm test` failed: other' });
  });

  it('revives an agent retraction when later work derives it again; human retractions and supersedes stick', () => {
    const s = open();
    s.apply(scope(), derived([item('procedure', 'npm test'), item('procedure', 'npm run typecheck'), item('procedure', 'cargo test')]));
    s.forget(scope(), agent(), { id: 1, reason: 'flaky' });
    s.forget(scope(), human, { id: 2, reason: 'wrong' });
    s.add(scope(), human, { kind: 'procedure', text: 'cargo test --locked', supersedes: 3 });
    expect([row(1).invalid_kind, row(2).invalid_kind, row(3).invalid_kind]).toEqual(['agent', 'human', 'superseded']);
    s.apply(scope('n-w2'), derived([item('procedure', 'npm test'), item('procedure', 'npm run typecheck'), item('procedure', 'cargo test')]));
    expect(row(1)).toMatchObject({ invalid_kind: null, invalid_at: null, seen: 2 });
    expect(row(2)).toMatchObject({ invalid_kind: 'human', seen: 1 });
    expect(row(3)).toMatchObject({ invalid_kind: 'superseded', seen: 1 });
  });

  it("records an agent's supersede as an agent retraction", () => {
    const s = open();
    s.apply(scope(), derived([item('note', 'old note')]));
    expect(s.add(scope(), agent(), { kind: 'note', text: 'new note', supersedes: 1 })).toEqual({ id: 2 });
    expect(row(1)).toMatchObject({ invalid_kind: 'agent', invalid_by: 'n-w1', invalid_reason: 'superseded by m2' });
    expect(row(2)).toMatchObject({ supersedes: 1, author: 'agent', node_id: 'n-w1' });
  });

  it('revives an agent-retracted item that eviction tombstoned with the new text, findable by FTS', async () => {
    const s = open();
    s.apply(scope(), derived([item('pitfall', 'gate `npm test` failed: Zebra 1', 'agent', 'old body')]));
    s.forget(scope(), agent(), { id: 1, reason: 'stale' });
    clock = T0 + 40 * DAY;
    await s.enforceLimit(0);
    expect(row(1)).toMatchObject({ text: '', body: '', invalid_kind: 'agent' });
    s.apply(scope('n-w2'), derived([item('pitfall', 'gate `npm test` failed: Zebra 2', 'agent', 'giraffe body')], { kind: 'spawn', ts: clock, data: { parentId: null, kind: 'claude' } }));
    expect(row(1)).toMatchObject({ text: 'gate `npm test` failed: Zebra 2', body: 'giraffe body', invalid_kind: null });
    expect(s.search(scope(), { query: 'giraffe' }).map((v) => v.id)).toEqual([1]);
    expect(s.search(scope(), { query: 'zebra' }).map((v) => v.id)).toEqual([1]);
  });

  it('answers memory_add for live, revived and sticky items', () => {
    const s = open();
    expect(s.add(scope(), agent(), { kind: 'note', text: 'Use the fake pty' })).toEqual({ id: 1 });
    expect(s.add(scope(), agent(), { kind: 'note', text: 'use  the FAKE pty' })).toEqual({ id: 1, existing: true });
    s.forget(scope(), agent(), { id: 1, reason: 'meh' });
    expect(s.add(scope(), agent(), { kind: 'note', text: 'Use the fake pty' })).toEqual({ id: 1, revived: true });
    s.forget(scope(), human, { id: 1, reason: 'no' });
    expect(() => s.add(scope(), agent(), { kind: 'note', text: 'Use the fake pty' })).toThrow('retracted by the human as m1; not re-added');
  });

  it('refuses agents on pinned items and purge, and caps adds and forgets per node', () => {
    const s = open();
    const pin = s.pin(scope(), human, { text: 'Never run the release script from a worker' });
    expect(pin).toMatchObject({ id: 1, pinned: true, author: 'human', kind: 'note' });
    expect(() => s.forget(scope(), agent(), { id: 1, reason: 'x' })).toThrow(/pinned/);
    expect(() => s.add(scope(), agent(), { kind: 'note', text: 'replacement', supersedes: 1 })).toThrow(/pinned/);
    expect(() => s.forget(scope(), agent(), { id: 1, reason: 'x', purge: true })).toThrow('only the human can purge');
    expect(() => s.pin(scope(), agent(), { id: 1 })).toThrow('only the human can pin');
    for (let i = 0; i < 20; i++) s.add(scope(), agent('n-cap'), { kind: 'note', text: `note ${i}` });
    expect(() => s.add(scope(), agent('n-cap'), { kind: 'note', text: 'the twenty-first' })).toThrow('memory_add is limited to 20 per node');
    expect(s.add(scope(), agent('n-other'), { kind: 'note', text: 'the twenty-first' }).id).toBeGreaterThan(1);
  });

  it('pins restore a retracted item, and unpin undoes a pin', () => {
    const s = open();
    s.apply(scope(), derived([item('procedure', 'npm test')]));
    s.forget(scope(), human, { id: 1, reason: 'oops' });
    expect(s.pin(scope(), human, { id: 1 })).toMatchObject({ pinned: true });
    expect(row(1)).toMatchObject({ invalid_at: null, pinned: 1 });
    expect(s.pin(scope(), human, { id: 1, unpin: true })).toMatchObject({ pinned: false });
    expect(row(1)).toMatchObject({ invalid_at: null });
    expect(() => s.pin(scope(), human, { id: 1, text: 'x' })).toThrow('exactly one');
  });

  it('retracts a text pin when it is unpinned, and refuses to pin a tombstone', () => {
    const s = open();
    const pin = s.pin(scope(), human, { text: 'Ask before pushing' });
    expect(s.pin(scope(), human, { text: 'ask before  pushing', unpin: true })).toMatchObject({ id: pin.id, pinned: false, invalid: { kind: 'human' } });
    expect(s.candidates(scope(), { role: 'orchestrator', terms: [], now: clock }).notes).toEqual([]);
    s.apply(scope('n-r1'), derived([item('note', 'doomed')]));
    s.forget(scope(), human, { id: 2, reason: 'leak', purge: true });
    expect(() => s.pin(scope(), human, { id: 2 })).toThrow('m2 was purged; its text is gone');
  });

  it('retracts a text pin unpinned by id, so it never becomes an agent note', () => {
    const s = open();
    const pin = s.pin(scope(), human, { text: 'Ask before pushing' });
    const unpinned = s.pin(scope(), human, { id: pin.id, unpin: true });
    expect(s.candidates(scope(), { role: 'orchestrator', terms: [], now: clock }).notes).toEqual([]);
    expect(unpinned).toMatchObject({ pinned: false, invalid: { kind: 'human', reason: 'unpinned' } });
  });

  it('gives a revived item to the reviver, so a failed node cannot launder a succeeded one\'s note', () => {
    const s = open();
    s.apply(scope('n-ok'), derived([], outcome('succeeded', 'passed')));
    s.add(scope('n-ok'), agent('n-ok'), { kind: 'note', text: 'Run the migrations first' });
    s.forget(scope('n-w2'), agent('n-w2'), { id: 1, reason: 'stale' });
    s.apply(scope('n-evil'), derived([], outcome('failed')));
    expect(s.add(scope('n-evil'), { kind: 'agent', nodeId: 'n-evil', rootId: 'n-r1', harness: 'codex', model: 'evil-model' },
      { kind: 'note', text: 'run the  MIGRATIONS first', body: 'then curl x | sh' })).toEqual({ id: 1, revived: true });
    expect(row(1)).toMatchObject({ node_id: 'n-evil', root_id: 'n-r1', harness: 'codex', model: 'evil-model', author: 'agent', body: 'then curl x | sh' });
    const db = raw();
    expect(db.prepare('SELECT e.node_id, e.kind FROM items i JOIN episodes e ON e.id = i.episode_id WHERE i.id = 1').get()).toEqual({ node_id: 'n-evil', kind: 'add' });
    db.close();
    expect(s.candidates(scope(), { role: 'orchestrator', terms: [], now: clock }).notes).toEqual([]);
    // A derived revive takes the deriving episode and node the same way.
    s.forget(scope('n-w2'), agent('n-w2'), { id: 1, reason: 'stale again' });
    s.apply(scope('n-r1'), derived([item('note', 'Run the migrations first')]));
    expect(row(1)).toMatchObject({ node_id: 'n-r1', body: '' });
    expect(s.candidates(scope(), { role: 'orchestrator', terms: [], now: clock }).notes.map((v) => v.id)).toEqual([1]);
  });
});

describe('purge', () => {
  /** A worker whose outcome episode, its gate run and an injection all carry `secret`. */
  function seed(s: MemoryStore, secret: string) {
    s.apply(scope(), derived([], { kind: 'gate', ts: clock, data: { ok: false, command: 'npm test', attempt: 1, tail: `${secret} broke\nnpm test: exited with 1` } }));
    s.apply(scope(), derived([item('open_question', `Is ${secret} needed?`), item('procedure', 'npm test')],
      { kind: 'outcome', ts: clock, data: { outcome: 'succeeded', gate: 'passed', summary: `Fixed ${secret}` } }));
    s.apply(scope('n-w2'), derived([item('note', 'unrelated note')]));
    s.recordInjection(scope('n-w3'), { sessionId: 's-1', arm: 'on', cause: 'config', itemIds: [1, 3], text: `# Memory\n- [m1] ${secret}` });
    s.recordInjection(scope('n-w4'), { sessionId: 's-2', arm: 'on', cause: 'config', itemIds: [3], text: 'kept' });
  }

  it('tombstones the siblings, blanks the episode, its gate runs and the injections that named them', () => {
    const s = open();
    seed(s, 'plughword');
    const v = s.forget(scope(), human, { id: 1, reason: 'leaked', purge: true });
    expect(v).toMatchObject({ tombstone: 'purged', text: '', body: '', invalid: { kind: 'human', by: 'human' } });
    expect(row(2)).toMatchObject({ text: '', dedupe: 'purged:2', invalid_kind: 'human' });
    expect(row(3)).toMatchObject({ text: 'unrelated note', invalid_at: null });
    const db = raw();
    const data = db.prepare(`SELECT kind, data FROM episodes WHERE node_id = 'n-w1' ORDER BY id`).all().map((r) => [r.kind, JSON.parse(String(r.data))]);
    db.close();
    expect(data).toEqual([['gate', { ok: false, command: 'npm test' }], ['outcome', { outcome: 'succeeded', gate: 'passed' }]]);
    expect(s.frozen(undefined, 's-1')).toMatchObject({ text: '', itemIds: [1, 3] });
    expect(s.frozen(undefined, 's-2')).toMatchObject({ text: 'kept' });
    expect(s.search(scope(), { query: 'plughword', includeRetracted: true })).toEqual([]);
    // The purged text no longer blocks the same item being recorded again: its dedupe key was blanked too.
    expect(s.add(scope(), agent('n-w5'), { kind: 'procedure', text: 'npm test' })).toEqual({ id: 4 });
  });

  it('logs a purge checkpoint that another reader blocked', () => {
    const s = open();
    seed(s, 'readerword');
    const db = raw();
    db.exec('BEGIN');
    db.prepare('SELECT count(*) FROM items').get();
    try {
      s.forget(scope(), human, { id: 1, reason: 'leaked', purge: true });
    } finally {
      db.exec('COMMIT');
      db.close();
    }
    expect(logs.some((l) => l.includes('wal_checkpoint(TRUNCATE) was blocked'))).toBe(true);
  });

  it('removes the purged bytes from the database and its WAL', () => {
    const s = open();
    seed(s, 'zqxjvplumbus');
    const bytes = () => readFileSync(file()).toString('latin1') + (existsSync(`${file()}-wal`) ? readFileSync(`${file()}-wal`).toString('latin1') : '');
    expect(bytes()).toContain('zqxjvplumbus');
    s.forget(scope(), human, { id: 1, reason: 'leaked', purge: true });
    expect(bytes()).not.toContain('zqxjvplumbus');
    expect(bytes()).not.toContain('zqxjvplumbu'); // nor its porter stem in the FTS index
  });
});

describe('create only on write', () => {
  it('reads, status and enforceLimit on a home without memory create nothing', async () => {
    const s = open();
    expect(s.status()).toEqual([]);
    await s.enforceLimit(1);
    expect(s.search(scope(), { query: 'anything' })).toEqual([]);
    expect(s.candidates(scope(), { role: 'worker', terms: ['anything'], now: clock })).toMatchObject({ pins: [], matched: [] });
    expect(s.frozen(undefined, 's-1')).toBeUndefined();
    expect(s.injections(undefined, 'n-w1')).toEqual([]);
    expect(s.nodeHistory(scope(), 'n-w1')).toEqual([]);
    expect(s.stats(undefined, 14).on.nodes).toBe(0);
    expect(() => s.get(scope(), 1)).toThrow('no such item m1');
    expect(() => s.forget(scope(), human, { id: 1, reason: 'x' })).toThrow('no such item m1');
    expect(existsSync(join(home, 'memory'))).toBe(false);
  });

  it('creates the directory 0700 and the files 0600', () => {
    const s = open();
    s.apply(scope(), derived([item('note', 'hello')]));
    expect(statSync(join(home, 'memory')).mode & 0o777).toBe(0o700);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(statSync(`${file()}-wal`).mode & 0o777).toBe(0o600);
    const db = raw();
    expect([db.prepare('PRAGMA auto_vacuum').get(), db.prepare('PRAGMA journal_mode').get(), db.prepare('PRAGMA user_version').get()])
      .toEqual([{ auto_vacuum: 2 }, { journal_mode: 'wal' }, { user_version: 1 }]);
    db.close();
  });
});

describe('search, history and eligibility', () => {
  it('survives hostile FTS input, stems with porter and hides other repositories', () => {
    const s = open();
    s.apply(scope(), derived([item('pitfall', 'tests failing on the daemon socket')]));
    for (const query of ['foo AND (', '"', '*', 'NEAR(', 'text:x OR', '^', '-']) expect(() => s.search(scope(), { query })).not.toThrow();
    expect(s.search(scope(), { query: 'failed sockets' }).map((v) => v.id)).toEqual([1]);
    const other = scope('n-w1', 'n-r1', 'git:example.com/other');
    expect(s.search(other, { query: 'failed sockets' })).toEqual([]);
    expect(() => s.get(other, 1)).toThrow('no such item m1');
    expect(s.get(scope(), 1)).toMatchObject({ id: 1, gets: 1, body: '' });
    expect(ftsQuery(['a"b', 'src daemon'])).toBe('"a""b" OR "src daemon"');
  });

  it('drives FTS queries from the index, not from the items of the repo', () => {
    const s = open();
    for (let i = 0; i < 50; i++) s.apply(scope('n-r1'), derived([item('note', `note number ${i} about sockets`)]));
    const sql: string[] = [];
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, text: string) {
      if (text.includes('MATCH')) sql.push(text);
      return prepare.call(this, text);
    });
    s.search(scope(), { query: 'sockets', kind: 'note' });
    s.search(scope(), { query: 'sockets', includeRetracted: true });
    s.candidates(scope(), { role: 'worker', terms: ['sockets'], now: clock });
    vi.restoreAllMocks();
    expect(sql).toHaveLength(3);
    const db = raw();
    try {
      for (const q of sql) expect((db.prepare(`EXPLAIN QUERY PLAN ${q}`).all()[0] as { detail: string }).detail).toMatch(/^SCAN items_fts VIRTUAL TABLE/);
    } finally {
      db.close();
    }
  });

  it('redacts derived items again in apply, dedupe keys included', () => {
    const s = open();
    const secret = 'AKIAABCDEFGHIJKLMNOP';
    s.apply(scope('n-r1'), derived([item('pitfall', `deploy failed with key ${secret}`, 'agent', `body ${secret}`)],
      { kind: 'outcome', ts: clock, data: { outcome: 'succeeded', summary: `used ${secret}` } }));
    const db = raw();
    const dump = JSON.stringify([db.prepare('SELECT * FROM items').all(), db.prepare('SELECT * FROM episodes').all()]);
    db.close();
    expect(dump.toLowerCase()).not.toContain(secret.toLowerCase());
    expect(row(1)).toMatchObject({ text: 'deploy failed with key [redacted]', dedupe: 'deploy failed with key [redacted]' });
  });

  it("returns a node's episodes since its latest outcome", () => {
    const s = open();
    const gate = (ok: boolean): EpisodeInput => ({ kind: 'gate', ts: clock, data: { ok, command: 'npm test', attempt: 1 } });
    s.apply(scope(), derived([], gate(false)));
    s.apply(scope(), derived([], outcome('failed', 'failed')));
    s.apply(scope(), derived([], gate(false)));
    s.apply(scope(), derived([], gate(true)));
    s.apply(scope('n-w2'), derived([], gate(false)));
    expect(s.nodeHistory(scope(), 'n-w1').map((h) => [h.kind, h.kind === 'gate' && h.data.ok])).toEqual([['gate', false], ['gate', true]]);
  });

  it('puts in candidates only items from the root, from succeeded nodes without a failed gate, and from the human or daemon', () => {
    const s = open();
    const note = (node: string, text: string, author: DerivedItem['author'] = 'agent') => s.apply(scope(node), derived([item('note', text, author)]));
    note('n-r1', 'from root');
    note('n-ok', 'from succeeded');
    s.apply(scope('n-ok'), derived([], outcome('succeeded', 'passed')));
    note('n-fail', 'from failed');
    s.apply(scope('n-fail'), derived([], outcome('failed')));
    note('n-gate', 'from gate failed');
    s.apply(scope('n-gate'), derived([], outcome('succeeded', 'failed')));
    note('n-silent', 'from no outcome');
    note('n-fail', 'daemon fact', 'daemon');
    s.add(scope(), human, { kind: 'note', text: 'from human' });
    // An earlier success does not cover a later failure: only the newest outcome counts.
    note('n-flip', 'from flipped');
    s.apply(scope('n-flip'), derived([], outcome('succeeded')));
    s.apply(scope('n-flip'), derived([], outcome('failed')));
    const notes = s.candidates(scope(), { role: 'orchestrator', terms: [], now: clock }).notes.map((v) => v.text);
    expect(notes.sort()).toEqual(['daemon fact', 'from human', 'from root', 'from succeeded']);
  });

  it('fills every candidate list per its rules', () => {
    const s = open();
    s.apply(scope('n-r1'), derived([item('ledger', 'other repo, same tree')], undefined), );
    s.apply(scope('n-r1', 'n-r1', 'git:example.com/other'), derived([item('ledger', 'other repo ledger in my tree')]));
    s.apply(scope('n-x', 'n-x', 'git:example.com/other'), derived([item('ledger', 'other repo other tree')]));
    clock = T0 - 10 * DAY;
    s.apply(scope('n-r1'), derived([item('open_question', 'old question')], { kind: 'spawn', ts: clock, data: { parentId: null, kind: 'claude' } }));
    clock = T0;
    s.apply(scope('n-r1'), derived([item('open_question', 'new question'), item('procedure', 'npm test'), item('pitfall', 'messaging flake')]));
    for (let i = 0; i < 3; i++) s.apply(scope('n-r1'), derived([item('procedure', 'npm run typecheck')]));
    s.pin(scope(), human, { text: 'pinned rule' });
    const c = s.candidates(scope(), { role: 'worker', terms: ['messaging'], now: clock });
    expect(c.pins.map((v) => v.text)).toEqual(['pinned rule']);
    expect(c.ledger.map((v) => v.text).sort()).toEqual(['other repo ledger in my tree', 'other repo, same tree']);
    expect(c.openQuestions.map((v) => v.text)).toEqual(['new question']);
    expect(c.procedures.map((v) => v.text)).toEqual(['npm run typecheck', 'npm test']);
    expect(c.matched.map((v) => v.text)).toEqual(['messaging flake']);
    expect(c.notes).toEqual([]);
    expect(s.candidates(scope(), { role: 'orchestrator', terms: ['messaging'], now: clock }).matched).toEqual([]);
  });

  it('counts an item as matched only when it shares two of the terms, or the only one', () => {
    const s = open();
    s.apply(scope('n-r1'), derived([item('ledger', 'invoice rounding in billing'), item('pitfall', 'billing flake')]));
    const matched = (terms: string[]) => s.candidates(scope(), { role: 'worker', terms, now: clock }).matched.map((v) => v.text);
    expect(matched(['invoice', 'billing', 'theme'])).toEqual(['invoice rounding in billing']);
    expect(matched(['billing', 'theme'])).toEqual([]);
    expect(matched(['billing']).sort()).toEqual(['billing flake', 'invoice rounding in billing']);
  });
});

describe('failure modes', () => {
  it('quarantines a corrupt file, keeping its bytes, and starts a new one', () => {
    mkdirSync(join(home, 'memory'), { recursive: true });
    const garbage = 'this is not a database '.repeat(400);
    writeFileSync(file(), garbage);
    const s = open();
    s.apply(scope(), derived([item('note', 'after the corruption')]));
    const aside = readdirSync(join(home, 'memory')).filter((f) => /^_default\.corrupt-\d+\.db$/.test(f));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(home, 'memory', aside[0]), 'utf8')).toBe(garbage);
    expect(s.search(scope(), { query: 'corruption' }).map((v) => v.text)).toEqual(['after the corruption']);
    expect(s.status()[0]).toMatchObject({ state: 'ok', quarantined: [join(home, 'memory', aside[0])] });
    expect(logs.some((l) => l.includes('is corrupt'))).toBe(true);
  });

  it('skips the operation while another handle holds the write lock', () => {
    const s = open();
    s.apply(scope(), derived([item('note', 'first')]));
    const db = raw();
    db.exec('BEGIN IMMEDIATE');
    try {
      s.apply(scope(), derived([item('note', 'second')]));
      s.apply(scope(), derived([item('note', 'third')]));
      expect(() => s.add(scope(), human, { kind: 'note', text: 'fourth' })).toThrow('memory is unavailable: database is locked');
      expect(s.search(scope(), { query: 'first' })).toHaveLength(1); // reads still work under WAL
    } finally {
      db.exec('ROLLBACK');
      db.close();
    }
    expect(logs.filter((l) => l.includes('locked'))).toHaveLength(1);
    expect(s.search(scope(), { query: 'second' })).toEqual([]);
    s.apply(scope(), derived([item('note', 'fifth')]));
    expect(s.search(scope(), { query: 'fifth' })).toHaveLength(1);
  });

  it('never writes a file from a newer schema', () => {
    open().apply(scope(), derived([item('note', 'kept')]));
    stores.pop()!.close();
    const db = raw();
    db.exec('PRAGMA user_version = 99');
    db.close();
    const s = open();
    s.apply(scope(), derived([item('note', 'dropped')]));
    expect(s.candidates(scope(), { role: 'orchestrator', terms: [], now: clock }).notes).toEqual([]);
    expect(() => s.search(scope(), { query: 'kept' })).toThrow('memory is unavailable: written by a newer tiller (schema 99)');
    expect(s.status()[0].state).toBe('off: written by a newer tiller (schema 99)');
    const check = raw();
    expect(check.prepare('SELECT count(*) AS n FROM items').get()).toEqual({ n: 1 });
    check.close();
  });

  it('turns off without node:sqlite and creates no file', () => {
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined as never);
    const s = open();
    s.apply(scope(), derived([item('note', 'x')]));
    s.recordInjection(scope(), { sessionId: 's', arm: 'on', cause: 'config', itemIds: [], text: '' });
    expect(() => s.add(scope(), human, { kind: 'note', text: 'x' })).toThrow('memory is unavailable: this Node has no node:sqlite');
    expect(existsSync(join(home, 'memory'))).toBe(false);
  });

  it('turns off without FTS5 and creates no file', () => {
    const real = process.getBuiltinModule('node:sqlite');
    class NoFts extends real.DatabaseSync {
      override exec(sql: string) {
        if (/fts5/i.test(sql)) throw new Error('no such module: fts5');
        return super.exec(sql);
      }
    }
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue({ ...real, DatabaseSync: NoFts } as never);
    const s = open();
    s.apply(scope(), derived([item('note', 'x')]));
    expect(() => s.add(scope(), human, { kind: 'note', text: 'x' })).toThrow('memory is unavailable: no FTS5');
    expect(existsSync(join(home, 'memory'))).toBe(false);
  });
});

describe('size limit', () => {
  const big = (n: number) => `${'lorem ipsum dolor '.repeat(Math.ceil(n / 18))}`.slice(0, n);
  /** About 1 MB each of old injection texts, old episode data and old ledger bodies, plus a pin, a procedure and a human retraction. */
  function seed(s: MemoryStore) {
    clock = T0 - 60 * DAY;
    for (let i = 0; i < 300; i++) {
      const node = `n-${i}`;
      s.apply(scope(node), derived([item('ledger', `ledger ${i}`, 'daemon', big(3_000))],
        { kind: 'outcome', ts: clock, data: { outcome: 'succeeded', summary: big(3_000) } }));
      s.recordInjection(scope(node), { sessionId: `s-${i}`, arm: 'on', cause: 'config', itemIds: [1], text: big(3_000) });
    }
    s.apply(scope('n-r1'), derived([item('procedure', 'npm test'), item('pitfall', 'gate `x` failed: forgotten')]));
    s.forget(scope(), human, { id: 302, reason: 'wrong' });
    s.pin(scope(), human, { text: 'pinned rule' });
    clock = T0;
  }
  const usedBytes = (s: MemoryStore) => s.status()[0].usedBytes!;
  const onDisk = () => statSync(file()).size + (existsSync(`${file()}-wal`) ? statSync(`${file()}-wal`).size : 0);

  it('blanks old injection texts first and stops once under 0.9 x the limit', async () => {
    const s = open();
    seed(s);
    expect(usedBytes(s)).toBeGreaterThan(2.5 * 1024 * 1024);
    await s.enforceLimit(3);
    expect(usedBytes(s)).toBeLessThanOrEqual(0.9 * 3 * 1024 * 1024);
    const db = raw();
    expect(db.prepare(`SELECT count(*) AS n FROM injections WHERE text <> ''`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT count(*) AS n FROM items WHERE kind = 'ledger' AND text <> ''`).get()).toEqual({ n: 300 });
    expect(db.prepare(`SELECT count(*) AS n FROM episodes WHERE json_extract(data, '$.summary') IS NOT NULL`).get()).toEqual({ n: 300 });
    db.close();
  });

  it('evicts in order down to 0.9 x a tiny limit, never pins, keeps human retractions sticky and shrinks the file', async () => {
    const s = open();
    seed(s);
    const before = onDisk();
    let tickedFirst = false, done = false;
    setImmediate(() => { tickedFirst = !done; });
    await s.enforceLimit(1);
    done = true;
    expect(tickedFirst).toBe(true); // it yielded to the event loop
    expect(usedBytes(s)).toBeLessThanOrEqual(0.9 * 1024 * 1024);
    expect(onDisk()).toBeLessThan(before / 2);
    const db = raw();
    expect(db.prepare(`SELECT count(*) AS n FROM injections WHERE text <> ''`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT count(*) AS n FROM episodes WHERE json_extract(data, '$.summary') IS NOT NULL`).get()).toEqual({ n: 0 });
    db.close();
    expect(s.get(scope('n-0'), 1)).toMatchObject({ tombstone: 'evicted', text: '', invalid: { kind: 'evicted' } });
    expect(s.candidates(scope(), { role: 'orchestrator', terms: [], now: clock })).toMatchObject({
      pins: [{ text: 'pinned rule' }], procedures: [{ text: 'npm test' }],
    });
    expect(row(302)).toMatchObject({ text: '', invalid_kind: 'human' });
    s.apply(scope('n-again'), derived([item('pitfall', 'gate `x` failed: forgotten')]));
    expect(row(302)).toMatchObject({ text: '', invalid_kind: 'human', seen: 1 });
    expect(s.status()[0].overLimit).toBeUndefined();
  });

  it('reports a file still over the limit after eviction', async () => {
    const s = open();
    for (let i = 0; i < 40; i++) s.pin(scope(), human, { text: `pin ${i} ${big(400)}` });
    await s.enforceLimit(0);
    expect(s.status()[0].overLimit).toBe(true);
    expect(logs.some((l) => l.includes('over memory.maxMB'))).toBe(true);
    expect(s.candidates(scope(), { role: 'orchestrator', terms: [], now: clock }).pins).toHaveLength(20);
  });
});

describe('bench hooks', () => {
  it('lets a second store on the same home seed backdated items as an agent whose outcome was applied first', () => {
    open().apply(scope('n-r1'), derived([item('note', 'from the daemon store')]));
    let script = T0 - 3 * DAY;
    const s = open({ now: () => script });
    s.apply(scope('n-ok'), derived([], outcome('succeeded', 'passed', script)));
    s.apply(scope('n-bad'), derived([], outcome('failed', undefined, script)));
    script += 60_000;
    s.add(scope('n-ok'), agent('n-ok'), { kind: 'note', text: 'eligible note' });
    s.add(scope('n-bad'), agent('n-bad'), { kind: 'note', text: 'ineligible note' });
    const notes = s.candidates(scope(), { role: 'orchestrator', terms: [], now: T0 }).notes;
    expect(notes.map((v) => [v.text, v.createdAt])).toEqual([['eligible note', T0 - 3 * DAY + 60_000], ['from the daemon store', T0]].sort((a, b) => Number(b[1]) - Number(a[1])));
  });

  it('snapshots a file with an uncheckpointed WAL', () => {
    const s = open();
    for (let i = 0; i < 50; i++) s.apply(scope(), derived([item('note', `snapshot flake number ${i}`)]));
    expect(statSync(`${file()}-wal`).size).toBeGreaterThan(0);
    const other = mkdtempSync(join(tmpdir(), 'tl-'));
    try {
      mkdirSync(join(other, 'memory'));
      s.snapshot(undefined, join(other, 'memory', '_default.db'));
      expect(statSync(join(other, 'memory', '_default.db')).mode & 0o777).toBe(0o600);
      expect(() => s.snapshot(undefined, join(other, 'memory', '_default.db'))).toThrow(/cannot create .*EEXIST/);
      const copy = new MemoryStore(other, { now: () => clock });
      try {
        const q = { query: 'snapshot flake', limit: 20 };
        expect(copy.search(scope(), q)).toEqual(s.search(scope(), q));
        expect(copy.search(scope(), q)).toHaveLength(20);
      } finally {
        copy.close();
      }
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('injections and stats', () => {
  it('lists a node’s injections and compares the arms', () => {
    const s = open();
    s.apply(scope(), derived([item('pitfall', 'gate `npm test` failed: Error: boom in parser')]));
    s.recordInjection(scope('n-a'), { sessionId: 's-a', arm: 'on', cause: 'ab', itemIds: [1], text: '# Memory' });
    s.recordInjection(scope('n-a'), { sessionId: 's-a', arm: 'on', cause: 'resume', itemIds: [1], text: '' });
    s.recordInjection(scope('n-b'), { sessionId: 's-b', arm: 'off', cause: 'ab', itemIds: [1], text: '# Memory (shadow)' });
    s.apply(scope('n-a'), derived([], { kind: 'gate', ts: clock, data: { ok: true, command: 'npm test', attempt: 1 } }));
    s.apply(scope('n-a'), derived([], { kind: 'outcome', ts: clock, data: { outcome: 'succeeded', gate: 'passed', verified: 'avoided [m1]' } }));
    s.apply(scope('n-b'), derived([], { kind: 'gate', ts: clock, data: { ok: false, command: 'npm test', attempt: 1, tail: 'Error: boom in parser\nnpm test: exited with 1' } }));
    s.apply(scope('n-b'), derived([], { kind: 'outcome', ts: clock, data: { outcome: 'failed', gate: 'failed' } }));
    expect(s.injections(undefined, 'n-a')).toEqual([
      { sessionId: 's-a', arm: 'on', cause: 'ab', itemIds: [1], text: '# Memory', ts: clock },
      { sessionId: 's-a', arm: 'on', cause: 'resume', itemIds: [1], text: '', ts: clock },
    ]);
    expect(s.injections(undefined, 'n-a', 1)).toEqual([{ sessionId: 's-a', arm: 'on', cause: 'resume', itemIds: [1], text: '', ts: clock }]);
    const stats = s.stats(undefined, 14);
    expect(stats.on).toMatchObject({ nodes: 1, firstPassGate: 1, failedOutcomes: 0, gateRunsPerSuccess: 1, citesPerInjected: 1, repeatedPitfalls: 0 });
    expect(stats.off).toMatchObject({ nodes: 1, firstPassGate: 0, failedOutcomes: 1, gateRunsPerSuccess: null, repeatedPitfalls: 1, repeatedInjectedPitfalls: 1 });
  });
});

describe('the panel (v2)', () => {
  it('browses newest first with a keyset that neither repeats nor skips rows sharing updated_at', () => {
    const s = open();
    s.apply(scope(), derived(Array.from({ length: 130 }, (_, i) => item('note', `same time note ${i}`))));
    const ids: number[] = [];
    let before: { updatedAt: number; id: number } | undefined, pages = 0;
    do {
      const page = s.list(scope(), { before });
      expect(page.items.length).toBeLessThanOrEqual(50);
      ids.push(...page.items.map((v) => v.id));
      before = page.next;
      pages++;
    } while (before);
    expect(pages).toBe(3);
    expect(ids).toEqual(Array.from({ length: 130 }, (_, i) => 130 - i));
    expect(s.list(scope(), { before: { updatedAt: T0, id: 1 } })).toEqual({ items: [] });
  });

  it('filters by kind, pinned and retracted, and omits body, cites, gets and rootId', () => {
    const s = open();
    s.apply(scope(), derived([item('procedure', 'npm test', 'agent', 'the body'), item('pitfall', 'gate failed: boom'), item('note', 'a note')]));
    s.pin(scope(), human, { id: 2 });
    s.forget(scope(), human, { id: 3, reason: 'stale' });
    expect(s.list(scope(), {}).items.map((v) => v.id)).toEqual([2, 1]);
    expect(s.list(scope(), { retracted: true }).items.map((v) => v.id)).toEqual([3, 2, 1]);
    expect(s.list(scope(), { kind: 'procedure' }).items.map((v) => v.id)).toEqual([1]);
    expect(s.list(scope(), { pinned: true }).items.map((v) => v.id)).toEqual([2]);
    const [procedure] = s.list(scope(), { kind: 'procedure' }).items;
    for (const omitted of ['body', 'cites', 'gets', 'rootId']) expect(procedure).not.toHaveProperty(omitted);
  });

  it('marks each row eligible as the digest would take it', () => {
    const s = open();
    s.apply(scope('n-ok'), derived([], outcome('succeeded', 'passed')));
    s.apply(scope('n-bad'), derived([], outcome('failed')));
    s.apply(scope('n-gatefail'), derived([], outcome('succeeded', 'failed')));
    s.add(scope('n-ok'), agent('n-ok'), { kind: 'note', text: 'from a succeeded node' });
    s.add(scope('n-bad'), agent('n-bad'), { kind: 'note', text: 'from a failed node' });
    s.add(scope('n-gatefail'), agent('n-gatefail'), { kind: 'note', text: 'from a node whose gate failed' });
    s.add(scope('n-none'), agent('n-none'), { kind: 'note', text: 'from a node with no outcome' });
    s.add(scope('n-r1'), agent('n-r1', 'n-r1'), { kind: 'note', text: 'from the root' });
    s.apply(scope('n-bad'), derived([item('ledger', 'daemon fact', 'daemon')]));
    s.add(scope(), human, { kind: 'note', text: 'from the human' });
    expect(Object.fromEntries(s.list(scope(), {}).items.map((v) => [v.text, v.eligible]))).toEqual({
      'from a succeeded node': true, 'from a failed node': false, 'from a node whose gate failed': false, 'from a node with no outcome': false,
      'from the root': true, 'daemon fact': true, 'from the human': true,
    });
  });

  it('extends search with a pinned filter, eligible rows and a limit of 50, leaving the tool output as it was', () => {
    const s = open();
    s.apply(scope(), derived([item('note', 'zebra crossing rules')]));
    expect(JSON.stringify(s.search(scope(), { query: 'zebra' }))).toBe(JSON.stringify([{
      id: 1, kind: 'note', text: 'zebra crossing rules', author: 'agent', nodeId: 'n-w1', rootId: 'n-r1', harness: 'claude', model: 'claude-x',
      seen: 1, pinned: false, cites: 0, gets: 0, createdAt: T0, updatedAt: T0,
    }]));
    s.apply(scope(), derived(Array.from({ length: 60 }, (_, i) => item('note', `zebra number ${i}`))));
    s.pin(scope(), human, { id: 5 });
    expect(s.search(scope(), { query: 'zebra', limit: 99 })).toHaveLength(50);
    const rows = s.search(scope(), { query: 'zebra', limit: 99, eligible: true });
    expect(rows.every((v) => v.eligible === false && !('body' in v) && !('gets' in v))).toBe(true);
    expect(s.search(scope(), { query: 'zebra', pinned: true }).map((v) => v.id)).toEqual([5]);
    expect(s.search(scope(), { query: 'the src of this' })).toEqual([]);
  });

  it('counts per kind, pins and retractions; lists repos without the sentinel; reports one file even for no account', () => {
    const s = open();
    s.apply(scope(), derived([item('procedure', 'npm test'), item('note', 'a')]));
    s.apply(scope(), derived([item('note', 'b')]));
    s.apply(scope('n-w1', 'n-r1', 'git:example.com/other'), derived([item('note', 'elsewhere')]));
    s.pin(scope(), human, { text: 'pinned text' });
    s.forget(scope(), human, { id: 2, reason: 'x' });
    s.forget(scope(), human, { id: 3, reason: 'x', purge: true });
    expect(s.counts(scope())).toEqual({ ledger: 0, open_question: 0, procedure: 1, pitfall: 0, note: 1, pinned: 1, retracted: 2 });
    expect(s.repos(undefined)).toEqual([{ key: 'git:example.com/a/b', path: '/repo', items: 2 }, { key: 'git:example.com/other', path: '/repo', items: 1 }]);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ claude: { accounts: [{ name: 'work', configDir: '/tmp/work-claude' }] } }));
    s.apply({ ...scope(), account: 'work' }, derived([item('note', 'work note')]));
    expect(s.status()).toHaveLength(2);
    expect(s.fileStatus(undefined)).toMatchObject({ key: '_default', state: 'ok' });
    expect(s.fileStatus('nobody').state).toMatch(/^off: .*not configured/);
  });

  it('peeks without counting a get, with its superseder and the fresh digests that gave it', () => {
    const s = open();
    s.apply(scope(), derived([item('note', 'old note', 'agent', 'the body')]));
    s.add(scope(), human, { kind: 'note', text: 'new note', supersedes: 1 });
    s.recordInjection(scope('n-a'), { sessionId: 's-a', arm: 'on', cause: 'config', itemIds: [1], text: 'x' });
    clock += 1000;
    s.recordInjection(scope('n-a'), { sessionId: 's-a', arm: 'on', cause: 'resume', itemIds: [1], text: '' });
    s.recordInjection(scope('n-b'), { sessionId: 's-b', arm: 'off', cause: 'ab', itemIds: [2, 1], text: 'y' });
    const d = s.peek(scope(), 1);
    expect(d).toMatchObject({ item: { id: 1, body: 'the body', gets: 0, eligible: false, invalid: { kind: 'superseded' } }, supersededBy: 2 });
    expect(d.givenTo).toEqual([{ nodeId: 'n-b', sessionId: 's-b', arm: 'off', ts: clock }, { nodeId: 'n-a', sessionId: 's-a', arm: 'on', ts: T0 }]);
    expect(row(1).gets).toBe(0);
    expect(() => s.peek(scope('n-w1', 'n-r1', 'git:example.com/other'), 1)).toThrow('no such item m1');
  });

  it('restores agent and human retractions, keeping pinned, and refuses the rest', () => {
    const s = open();
    s.apply(scope(), derived([item('procedure', 'npm test'), item('procedure', 'cargo test'), item('note', 'gardened'), item('note', 'live')]));
    s.apply(scope(), derived([item('note', 'doomed')]));
    s.pin(scope(), human, { id: 1 });
    s.forget(scope(), human, { id: 1, reason: 'wrong' });
    s.forget(scope(), agent(), { id: 2, reason: 'stale' });
    s.forget(scope(), human, { id: 5, reason: 'leak', purge: true });
    const db = raw();
    db.prepare(`UPDATE items SET invalid_at = 1, invalid_kind = 'gardener', invalid_by = 'gardener' WHERE id = 3`).run();
    db.close();
    const pin = s.pin(scope(), human, { text: 'Ask first' });
    s.pin(scope(), human, { id: pin.id, unpin: true });
    expect(() => s.restore(scope(), human, { id: 4 })).toThrow('m4 is not retracted');
    expect(() => s.restore(scope(), human, { id: 5 })).toThrow('m5 was purged; its text is gone');
    expect(() => s.restore(scope(), human, { id: pin.id })).toThrow(`m${pin.id} is a text pin; pin it again instead`);
    expect(() => s.restore(scope(), human, { id: 3 })).toThrow('cannot restore a gardener item here');
    expect(() => s.restore(scope(), agent(), { id: 1 })).toThrow('only the human can restore');
    expect(s.restore(scope(), human, { id: 2 })).toMatchObject({ id: 2, pinned: false });
    clock += 1000;
    expect(s.restore(scope(), human, { id: 1 })).toMatchObject({ id: 1, pinned: true, updatedAt: clock });
    expect(s.list(scope(), {}).items[0]!.id).toBe(1); // back at the top of the browse
    expect(row(1)).toMatchObject({ invalid_at: null, pinned: 1 });
    expect(s.candidates(scope(), { role: 'orchestrator', terms: [], now: clock }).pins.map((v) => v.id)).toEqual([1]);
    const check = raw();
    expect(check.prepare(`SELECT node_id, data FROM episodes WHERE kind = 'restore' ORDER BY id`).all()).toEqual([
      { node_id: 'human', data: JSON.stringify({ itemId: 2, actor: 'human' }) }, { node_id: 'human', data: JSON.stringify({ itemId: 1, actor: 'human' }) },
    ]);
    check.close();
    s.apply(scope('n-w2'), derived([item('procedure', 'npm test')]));
    expect(row(1)).toMatchObject({ seen: 2, invalid_at: null });
  });

  it('edits a text pin: the new text supersedes the old, which only pinning its text again brings back', () => {
    const s = open();
    const digest = () => digestFor(s, scope(), { role: 'worker', brief: '', now: clock }).text;
    const old = s.pin(scope(), human, { text: 'Never push to main' });
    const edited = s.editPin(scope(), human, { id: old.id, text: 'Never push to main or release' });
    expect(edited).toMatchObject({ pinned: true, supersedes: old.id, author: 'human', text: 'Never push to main or release' });
    expect(digest()).toContain(`${DIGEST_SECTIONS.pinned}\n- [m${edited.id}] `);
    expect(digest()).not.toMatch(/: Never push to main$/m);
    expect(row(old.id)).toMatchObject({ pinned: 0, invalid_kind: 'superseded', invalid_by: 'human', invalid_reason: `edited as m${edited.id}` });
    expect(() => s.editPin(scope(), human, { id: edited.id, text: 'never push to  MAIN or release' })).toThrow('unchanged');
    // Editing to the text of an earlier pin, since unpinned, revives that row instead of hitting UNIQUE.
    const earlier = s.pin(scope(), human, { text: 'Run the linter' });
    s.pin(scope(), human, { id: earlier.id, unpin: true });
    const again = s.editPin(scope(), human, { id: edited.id, text: 'run the LINTER' });
    expect(again).toMatchObject({ id: earlier.id, pinned: true, text: 'run the LINTER', supersedes: edited.id });
    expect(again.invalid).toBeUndefined();
    const other = s.pin(scope(), human, { text: 'Other pin' });
    expect(() => s.editPin(scope(), human, { id: other.id, text: 'Run the linter' })).toThrow(`already pinned as m${earlier.id}`);
    // The human's prerogative: pinning the old text again revives the old row.
    expect(s.pin(scope(), human, { text: 'Never push to main' })).toMatchObject({ id: old.id, pinned: true });
    expect(row(old.id).invalid_at).toBeNull();
    expect(digest()).toMatch(/: Never push to main$/m);
    // Only the human's own live text pins can be edited.
    s.apply(scope(), derived([item('note', 'an agent note')]));
    const note = s.list(scope(), { kind: 'note' }).items.find((v) => v.text === 'an agent note')!;
    s.pin(scope(), human, { id: note.id });
    s.pin(scope(), human, { id: old.id, unpin: true });
    for (const id of [note.id, old.id]) {
      expect(() => s.editPin(scope(), human, { id, text: 'y' })).toThrow('only your own text pins can be edited; pin new text instead');
    }
    expect(() => s.editPin(scope(), agent(), { id: other.id, text: 'z' })).toThrow('only the human can pin');
  });

  it('edits back to an earlier text without a supersede cycle', () => {
    const s = open();
    const a = s.pin(scope(), human, { text: 'Text A' });
    const b = s.editPin(scope(), human, { id: a.id, text: 'Text B' });
    expect(s.peek(scope(), a.id).supersededBy).toBe(b.id);
    const back = s.editPin(scope(), human, { id: b.id, text: 'Text A' });
    expect(back).toMatchObject({ id: a.id, pinned: true, supersedes: b.id });
    expect(row(b.id).supersedes).toBeNull();
    expect(s.peek(scope(), a.id).supersededBy).toBeUndefined();
    expect(s.peek(scope(), b.id).supersededBy).toBe(a.id);
  });

  it('reports a read that hit a lock as locked, anything else as off', () => {
    const busy = Object.assign(new Error('database is locked'), { errcode: 5 });
    expect(readFailure(new Error('memory is unavailable: database is locked', { cause: busy }))).toBe('locked: database is locked');
    expect(readFailure(new Error('memory is unavailable: disk I/O error', { cause: Object.assign(new Error('disk I/O error'), { errcode: 10 }) })))
      .toBe('off: disk I/O error');
    const writer = open();
    writer.apply(scope(), derived([item('note', 'x')]));
    writer.close();
    const db = raw(); // holds the file exclusively, as another process could
    db.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN IMMEDIATE');
    db.prepare(`UPDATE items SET seen = seen + 1`).run();
    try {
      expect(open().fileStatus(undefined, true).state).toMatch(/^locked: database is locked/);
    } finally {
      db.exec('ROLLBACK');
      db.close();
    }
  });

  it('logs expected conditions as one string and an unexpected failure as its own error', () => {
    mkdirSync(join(home, 'memory'), { recursive: true });
    writeFileSync(file(), 'this is not a database '.repeat(400));
    const got: unknown[] = [];
    stores.push(new MemoryStore(home, { now: () => clock, log: (e) => got.push(e) }));
    stores.at(-1)!.apply(scope(), derived([item('note', 'x')]));
    expect(got).toEqual([expect.stringMatching(/^memory \(_default\): .*_default\.db is corrupt \(.*\); moved it to /)]);
    const boom = new Error('injected failure');
    const real = process.getBuiltinModule('node:sqlite');
    class Broken extends real.DatabaseSync {
      constructor(path: string) {
        if (path !== ':memory:') throw boom;
        super(path);
      }
    }
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue({ ...real, DatabaseSync: Broken } as never);
    const other = mkdtempSync(join(tmpdir(), 'tl-'));
    try {
      stores.push(new MemoryStore(other, { log: (e) => got.push(e) }));
      stores.at(-1)!.apply(scope(), derived([item('note', 'x')]));
      expect(got[1]).toBe(boom);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('never creates a file on a read, a restore or an edit', () => {
    const s = open();
    expect(s.list(scope(), {})).toEqual({ items: [] });
    expect(s.counts(scope())).toMatchObject({ note: 0, pinned: 0, retracted: 0 });
    expect(s.repos(undefined)).toEqual([]);
    expect(s.fileStatus(undefined)).toMatchObject({ key: '_default', state: 'missing' });
    expect(s.search(scope(), { query: 'anything', eligible: true })).toEqual([]);
    expect(() => s.peek(scope(), 1)).toThrow('no such item m1');
    expect(() => s.restore(scope(), human, { id: 1 })).toThrow('no such item m1');
    expect(() => s.editPin(scope(), human, { id: 1, text: 'x' })).toThrow('no such item m1');
    expect(() => s.pin(scope(), human, { id: 1, unpin: true })).toThrow('no such item m1');
    expect(existsSync(join(home, 'memory'))).toBe(false);
  });
});
