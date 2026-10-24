// Memory benchmark Layer A (bench plan §2): labeled fixtures replayed through the real memory modules on a temp home,
// then capture, search and digest-selection assertions, the digest rendering contract, and the aggregate score floors.
// Deterministic and LLM-free. Set BENCH_OUT to a directory to also write the per-query scores as layer-a.json.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ArchivedNode, Harness, Outcome } from '../../src/shared/protocol.js';
import { derive } from '../../src/daemon/memory-derive.js';
import { DIGEST_HEADER, DIGEST_SECTIONS, digestFor } from '../../src/daemon/memory-digest.js';
import { LIMITS, redact, type Actor, type CaptureEvent, type DigestRole, type ItemKind, type ItemRow, type MemoryScope } from '../../src/daemon/memory-schema.js';
import { MemoryStore } from '../../src/daemon/memory-store.js';

// --- Fixture format (bench plan §2.1) ---

type Section = keyof typeof DIGEST_SECTIONS;
/** Picks items by kind, repo alias, exact text or text substrings. */
interface Matcher { kind?: ItemKind; repo?: string; text?: string; textIncludes?: string[] }
interface ExpectItem extends Matcher {
  label?: string; author?: string; harness?: string; nodeId?: string; seen?: number; retracted?: boolean; pinned?: boolean; bodyIncludes?: string[];
}
/** A captured event without ts; the loader fills ts, spawn's parentId and kind, gate's attempt and close's whole ArchivedNode. */
type FixtureEvent = { type: CaptureEvent['type'] } & Record<string, unknown>;
type Op =
  | { type: 'add'; kind: ItemKind; text: string; body?: string; supersedes?: string; label?: string }
  | { type: 'forget'; match: string; reason: string; purge?: boolean }
  | { type: 'pin'; match?: string; text?: string; unpin?: boolean; label?: string };
interface Episode {
  /** Offset from `now`, as -3d+5m. */
  at: string;
  repo: string;
  node?: string;
  /** Remembered per node; defaults: the node itself, claude, claude-haiku-5-5. */
  root?: string;
  harness?: Harness;
  model?: string;
  /** For an op: 'human', else the episode's node acts as an agent. */
  actor?: string;
  event?: FixtureEvent;
  op?: Op;
}
/** each, repeated with every "{i}" replaced by 1..repeat. */
interface Repeat { repeat: number; each: Episode[] }
interface Query {
  id: string;
  repo: string;
  role: DigestRole;
  brief?: string;
  must?: string[];
  should?: string[];
  forbidden?: string[];
  /** Default 8. */
  k?: number;
  /** Reported only: kept out of the aggregate floors. */
  report?: boolean;
  /** Labels that must be injected in this order. */
  ordered?: string[];
  /** [min, max] item lines per section. */
  sectionLines?: Partial<Record<Section, [number, number]>>;
  textIncludes?: string[];
  textExcludes?: string[];
  /** Reading harnesses whose digests must be byte-identical. */
  sameForHarnesses?: Harness[];
}
interface Search { repo: string; query: string; first?: string; includes?: string[]; excludes?: string[] }
interface Fixture {
  name: string;
  claim: number;
  note?: string;
  now: string;
  repos: Record<string, string>;
  episodes: (Episode | Repeat)[];
  expectItems?: ExpectItem[];
  forbidItems?: Matcher[];
  /** Rows of each kind across all repos, retracted ones included. */
  exactCounts?: Partial<Record<ItemKind, number>>;
  searches?: Search[];
  queries?: Query[];
  /** Strings that must not appear in the DB or WAL bytes. */
  absentBytes?: string[];
}
interface Floors { macroRecallAtK: number; meanWorkerPrecision: number }

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith('.json') && f !== 'floors.json').sort()
  .map((f) => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) as Fixture);
const floors = JSON.parse(readFileSync(join(FIXTURES, 'floors.json'), 'utf8')) as Floors;

const UNIT = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 } as const;
function offset(at: string): number {
  let ms = 0;
  const rest = at.replace(/([+-])(\d+)([dhms])/g, (_, sign: string, n: string, unit: keyof typeof UNIT) => {
    ms += (sign === '-' ? -1 : 1) * Number(n) * UNIT[unit];
    return '';
  });
  if (rest) throw new Error(`bad offset "${at}"`);
  return ms;
}

const expand = (episodes: (Episode | Repeat)[]): Episode[] => episodes.flatMap((e) => ('repeat' in e
  ? Array.from({ length: e.repeat }, (_, i) => JSON.parse(JSON.stringify(e.each).replaceAll('{i}', String(i + 1))) as Episode[]).flat()
  : [e]));

// --- Replay ---

interface NodeCtx { root: string; harness: Harness; model: string; parentId: string | null; createdAt: number; gates: number; prompt?: string; outcome?: Outcome }
type Row = ItemRow & { repo_key: string };

class Case {
  readonly home = mkdtempSync(join(tmpdir(), 'tl-bench-'));
  readonly now: number;
  private clock: number;
  readonly store: MemoryStore;
  private readonly labels = new Map<string, number>();
  private readonly nodes = new Map<string, NodeCtx>();

  constructor(readonly fx: Fixture) {
    this.now = this.clock = Date.parse(fx.now);
    this.store = new MemoryStore(this.home, { now: () => this.clock });
  }

  scope(repo: string): MemoryScope {
    const repoKey = this.fx.repos[repo];
    if (!repoKey) throw new Error(`unknown repo alias "${repo}"`);
    return { repoKey, repoPath: `/bench/${repo}` };
  }

  replay(): void {
    for (const ep of expand(this.fx.episodes)) {
      this.clock = this.now + offset(ep.at);
      const node = ep.node === undefined ? undefined : this.node(ep);
      const scope: MemoryScope = { ...this.scope(ep.repo), ...(node && { nodeId: ep.node, rootId: node.root, harness: node.harness, model: node.model }) };
      if (ep.event) {
        if (!node) throw new Error(`an event needs a node: ${JSON.stringify(ep)}`);
        // The capture funnel's order (plan R1): redact the whole event, then the node's history, derive and apply.
        const event = redact(this.capture(ep.event, ep.node!, node, ep.repo));
        this.store.apply(scope, derive(event, this.store.nodeHistory(scope, ep.node!)));
      } else if (ep.op) {
        const actor: Actor = ep.actor === 'human' ? { kind: 'human' }
          : node ? { kind: 'agent', nodeId: ep.node!, rootId: node.root, harness: node.harness, model: node.model }
            : (() => { throw new Error(`an op needs an actor or a node: ${JSON.stringify(ep)}`); })();
        this.op(ep.op, actor, actor.kind === 'human' ? this.scope(ep.repo) : scope);
      }
    }
    this.clock = this.now;
    for (const e of this.fx.expectItems ?? []) if (e.label) this.id(`@${e.label}`);
  }

  private node(ep: Episode): NodeCtx {
    let n = this.nodes.get(ep.node!);
    if (!n) {
      const root = ep.root ?? ep.node!;
      n = { root, harness: 'claude', model: 'claude-haiku-5-5', parentId: root === ep.node ? null : root, createdAt: this.clock, gates: 0 };
      this.nodes.set(ep.node!, n);
    }
    if (ep.root) n.root = ep.root;
    if (ep.harness) n.harness = ep.harness;
    if (ep.model) n.model = ep.model;
    return n;
  }

  /** The CaptureEvent the daemon would capture, with what the fixture leaves out filled in. */
  private capture(ev: FixtureEvent, id: string, n: NodeCtx, repo: string): CaptureEvent {
    const ts = this.clock;
    const { type, ...rest } = ev;
    switch (type) {
      case 'spawn': {
        const { prompt, ...spawn } = rest as { prompt?: string; parentId?: string | null };
        n.prompt = prompt ?? n.prompt;
        if (spawn.parentId !== undefined) n.parentId = spawn.parentId;
        return { type, ts, parentId: n.parentId, kind: 'claude', ...spawn };
      }
      case 'outcome': {
        const o = rest as unknown as Omit<Outcome, 'at'>;
        n.outcome = { ...o, at: ts };
        return { type, ts, ...o };
      }
      case 'gate': {
        n.gates++;
        return { type, ts, attempt: n.gates, ...(rest as { ok: boolean; command: string; tail?: string }) };
      }
      case 'close': {
        const archived: ArchivedNode = {
          id, rootId: n.root, parentId: n.parentId, title: id, cwd: `/bench/${repo}`, harness: n.harness, model: n.model,
          ...(n.prompt ? { prompt: n.prompt } : {}), ...(n.outcome ? { outcome: n.outcome } : {}), createdAt: n.createdAt, closedAt: ts,
          ...(rest.archived as Partial<ArchivedNode> | undefined),
        };
        return { type, ts, archived };
      }
      default:
        return { type, ts, ...rest } as CaptureEvent;
    }
  }

  private op(op: Op, actor: Actor, scope: MemoryScope): void {
    if (op.type === 'add') {
      const { id } = this.store.add(scope, actor, {
        kind: op.kind, text: op.text, ...(op.body ? { body: op.body } : {}), ...(op.supersedes ? { supersedes: this.id(op.supersedes) } : {}),
      });
      if (op.label) this.labels.set(op.label, id);
    } else if (op.type === 'forget') {
      this.store.forget(scope, actor, { id: this.id(op.match), reason: op.reason, ...(op.purge ? { purge: true } : {}) });
    } else {
      const { id } = this.store.pin(scope, actor, {
        ...(op.match ? { id: this.id(op.match) } : {}), ...(op.text ? { text: op.text } : {}), ...(op.unpin ? { unpin: true } : {}),
      });
      if (op.label) this.labels.set(op.label, id);
    }
  }

  /** Every item row, retracted ones included, with its repo key. */
  rows(): Row[] {
    const file = this.store.accountFile(undefined);
    if (!existsSync(file)) return [];
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare('SELECT i.*, r.key AS repo_key FROM items i JOIN repos r ON r.id = i.repo_id ORDER BY i.id').all() as unknown as Row[];
    } finally {
      db.close();
    }
  }

  matching(m: Matcher): Row[] {
    const repoKey = m.repo === undefined ? undefined : this.scope(m.repo).repoKey;
    return this.rows().filter((r) => (!m.kind || r.kind === m.kind) && (!repoKey || r.repo_key === repoKey)
      && (m.text === undefined || r.text === m.text) && (m.textIncludes ?? []).every((s) => r.text.includes(s)));
  }

  /** The id of an "@label": an op's label, else its expectItems matcher, which must match exactly one item. */
  id(ref: string): number {
    if (!ref.startsWith('@')) throw new Error(`a label reference starts with @: "${ref}"`);
    const label = ref.slice(1);
    const known = this.labels.get(label);
    if (known !== undefined) return known;
    const e = this.fx.expectItems?.find((x) => x.label === label);
    if (!e) throw new Error(`unknown label "${label}"`);
    const found = this.matching(e);
    if (found.length !== 1) throw new Error(`label "${label}" matches ${found.length} items, not 1: ${JSON.stringify(e)}`);
    this.labels.set(label, found[0].id);
    return found[0].id;
  }

  /** The label of an id, for readable failures. */
  name(id: number): string {
    return [...this.labels].find(([, v]) => v === id)?.[0] ?? `m${id}`;
  }

  close(): void {
    this.store.close();
    rmSync(this.home, { recursive: true, force: true });
  }
}

// --- The rendering contract (bench plan §2.2) ---

const HEADINGS = Object.entries(DIGEST_SECTIONS) as [Section, string][];
const ITEM_LINE = /^- \[m(\d+)\] \d+[mhd] ago · [^:\n]+: /;

/** The digest's contract violations, and its item ids per section in render order. */
function contract(text: string, itemIds: number[], role: DigestRole): { violations: string[]; sections: Partial<Record<Section, number[]>> } {
  const violations: string[] = [];
  const sections: Partial<Record<Section, number[]>> = {};
  if (text === '') {
    if (itemIds.length) violations.push('empty text with item ids');
    return { violations, sections };
  }
  if (!text.startsWith(`${DIGEST_HEADER}\n`)) violations.push('header differs from DIGEST_HEADER');
  if (text.length > LIMITS.digest.budget[role]) violations.push(`${text.length} chars over the ${role} budget ${LIMITS.digest.budget[role]}`);
  if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text)) violations.push('a C0/C1 control character');
  let current: Section | undefined;
  let order = -1;
  const seen: number[] = [];
  // Everything after the fixed header paragraph.
  const lines = text.slice(DIGEST_HEADER.length + 1).split('\n');
  lines.forEach((line, i) => {
    if (line.length > LIMITS.digest.line) violations.push(`a ${line.length}-char line`);
    if (line.includes('--- TL MESSAGE')) violations.push(`a TL frame line: ${line}`);
    if (line === '' && i === 0) return;
    if (line.startsWith('#')) {
      const at = HEADINGS.findIndex(([, h]) => h === line);
      if (at < 0) violations.push(`a heading outside the contract: ${line}`);
      else if (at <= order) violations.push(`section out of order or repeated: ${line}`);
      else [order, current] = [at, HEADINGS[at][0]];
      return;
    }
    const m = ITEM_LINE.exec(line);
    if (!m || !current) return violations.push(`not a whole item line under a heading: ${JSON.stringify(line)}`);
    seen.push(Number(m[1]));
    (sections[current] ??= []).push(Number(m[1]));
  });
  if (JSON.stringify(seen) !== JSON.stringify(itemIds)) violations.push(`rendered ids ${JSON.stringify(seen)} differ from itemIds ${JSON.stringify(itemIds)}`);
  const pinned = text.indexOf(DIGEST_SECTIONS.pinned);
  if (pinned >= 0) {
    const next = text.indexOf('\n## ', pinned + 1);
    const used = (next < 0 ? text.length : next) - pinned + 1; // + the newline before the heading, as buildDigest counts it
    if (used > LIMITS.digest.pinned) violations.push(`pinned section ${used} chars over ${LIMITS.digest.pinned}`);
  }
  return { violations, sections };
}

// --- Scores (bench plan §2.2) ---

interface Score {
  case: string; query: string; role: DigestRole; report: boolean; k: number; relevant: number; injected: number;
  recallAtK?: number; precision?: number; chars: number; relatedLines: number;
}
const scores: Score[] = [];

for (const fx of fixtures) {
  describe(fx.name, () => {
    let c: Case;
    beforeAll(() => {
      c = new Case(fx);
      c.replay();
    });
    afterAll(() => c?.close());

    it('captures the labeled items', () => {
      const rows = c.rows();
      const failures: string[] = [];
      for (const e of fx.expectItems ?? []) {
        const what = e.label ?? JSON.stringify(e);
        const found = e.label ? rows.filter((r) => r.id === c.id(`@${e.label}`)) : c.matching(e);
        if (found.length !== 1) { failures.push(`${what}: ${found.length} items match`); continue; }
        const r = found[0];
        if (e.author !== undefined && r.author !== e.author) failures.push(`${what}: author ${r.author}, not ${e.author}`);
        if (e.harness !== undefined && r.harness !== e.harness) failures.push(`${what}: harness ${r.harness}, not ${e.harness}`);
        if (e.nodeId !== undefined && r.node_id !== e.nodeId) failures.push(`${what}: node ${r.node_id}, not ${e.nodeId}`);
        if (e.seen !== undefined && r.seen !== e.seen) failures.push(`${what}: seen ${r.seen}, not ${e.seen}`);
        if (e.retracted !== undefined && (r.invalid_at !== null) !== e.retracted) failures.push(`${what}: retracted is ${r.invalid_at !== null}`);
        if (e.pinned !== undefined && (r.pinned === 1) !== e.pinned) failures.push(`${what}: pinned is ${r.pinned === 1}`);
        for (const s of e.bodyIncludes ?? []) if (!r.body.includes(s)) failures.push(`${what}: body lacks ${JSON.stringify(s)}: ${JSON.stringify(r.body)}`);
      }
      for (const m of fx.forbidItems ?? []) {
        for (const r of c.matching(m)) failures.push(`forbidden item ${JSON.stringify(m)} found: m${r.id} ${JSON.stringify(r.text)}`);
      }
      for (const [kind, n] of Object.entries(fx.exactCounts ?? {})) {
        const got = rows.filter((r) => r.kind === kind);
        if (got.length !== n) failures.push(`${got.length} ${kind} items, not ${n}: ${JSON.stringify(got.map((r) => r.text))}`);
      }
      if (fx.absentBytes?.length) {
        const file = c.store.accountFile(undefined);
        const bytes = [file, `${file}-wal`].filter(existsSync).map((f) => readFileSync(f).toString('latin1')).join('');
        for (const s of fx.absentBytes) if (bytes.includes(s)) failures.push(`${JSON.stringify(s)} is in the DB or WAL bytes`);
      }
      expect(failures).toEqual([]);
    });

    if (fx.searches?.length) {
      it('search finds and hides the labeled items', () => {
        const failures: string[] = [];
        for (const s of fx.searches!) {
          const ids = c.store.search(c.scope(s.repo), { query: s.query }).map((v) => v.id);
          const what = `search ${JSON.stringify(s.query)} in ${s.repo} gave [${ids.map((id) => c.name(id))}]`;
          if (s.first && ids[0] !== c.id(s.first)) failures.push(`${what}: ${s.first} is not first`);
          for (const l of s.includes ?? []) if (!ids.includes(c.id(l))) failures.push(`${what}: lacks ${l}`);
          for (const l of s.excludes ?? []) if (ids.includes(c.id(l))) failures.push(`${what}: has ${l}`);
        }
        expect(failures).toEqual([]);
      });
    }

    for (const q of fx.queries ?? []) {
      it(`digest ${q.id} (${q.role}${q.report ? ', reported' : ''})`, () => {
        const scope = (harness: Harness): MemoryScope =>
          ({ ...c.scope(q.repo), nodeId: `n-query-${q.id}`, rootId: `n-query-${q.id}`, harness, model: 'bench' });
        const { text, itemIds } = digestFor(c.store, scope('claude'), { role: q.role, brief: q.brief, now: c.now });
        const { violations, sections } = contract(text, itemIds, q.role);
        const failures = [...violations];
        const injected = new Set(itemIds);
        const shown = `[${itemIds.map((id) => c.name(id))}]`;
        for (const l of q.must ?? []) if (!injected.has(c.id(l))) failures.push(`must ${l} not injected: ${shown}`);
        const rows = new Map(c.rows().map((r) => [r.id, r]));
        for (const l of q.forbidden ?? []) {
          const id = c.id(l);
          if (injected.has(id)) failures.push(`forbidden ${l} injected`);
          // A retracted item must also stay out of search; an ineligible live one stays searchable by design (D4).
          const r = rows.get(id)!;
          if (r.invalid_at !== null && r.text && c.store.search(c.scope(q.repo), { query: r.text }).some((v) => v.id === id)) {
            failures.push(`forbidden retracted ${l} found by search`);
          }
        }
        if (q.ordered) {
          const at = q.ordered.map((l) => itemIds.indexOf(c.id(l)));
          if (at.some((i, n) => i < 0 || (n > 0 && i <= at[n - 1]))) failures.push(`not in order ${q.ordered}: ${shown}`);
        }
        for (const [section, [min, max]] of Object.entries(q.sectionLines ?? {}) as [Section, [number, number]][]) {
          const n = sections[section]?.length ?? 0;
          if (n < min || n > max) failures.push(`${n} lines under ${section}, not ${min}-${max}`);
        }
        for (const s of q.textIncludes ?? []) if (!text.includes(s)) failures.push(`text lacks ${JSON.stringify(s)}`);
        for (const s of q.textExcludes ?? []) if (text.includes(s)) failures.push(`text has ${JSON.stringify(s)}`);
        for (const h of q.sameForHarnesses ?? []) {
          if (digestFor(c.store, scope(h), { role: q.role, brief: q.brief, now: c.now }).text !== text) failures.push(`the digest differs for a ${h} reader`);
        }
        const relevant = new Set([...(q.must ?? []), ...(q.should ?? [])].map((l) => c.id(l)));
        const k = q.k ?? 8;
        const hits = (ids: number[]) => ids.filter((id) => relevant.has(id)).length;
        scores.push({
          case: fx.name, query: q.id, role: q.role, report: !!q.report, k, relevant: relevant.size, injected: itemIds.length,
          ...(relevant.size ? { recallAtK: hits(itemIds.slice(0, k)) / relevant.size } : {}),
          ...(relevant.size ? { precision: itemIds.length ? hits(itemIds) / itemIds.length : 0 } : {}),
          chars: text.length, relatedLines: sections.related?.length ?? 0,
        });
        expect(failures, text).toEqual([]);
      });
    }
  });
}

// R9: placeholders wait as todo or skip, never it.fails, so the suite stays green when the behaviour lands.
it.todo('replays fixtures through NodeManager.captureMemory (W5) instead of this file\'s redact, nodeHistory, derive and apply');

describe('aggregate', () => {
  it('meets the floors in fixtures/floors.json', () => {
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
    const counted = scores.filter((s) => !s.report);
    const macroRecallAtK = mean(counted.flatMap((s) => (s.recallAtK === undefined ? [] : [s.recallAtK])));
    const meanWorkerPrecision = mean(counted.flatMap((s) => (s.role === 'worker' && s.precision !== undefined ? [s.precision] : [])));
    console.table(scores.map((s) => ({ ...s, recallAtK: s.recallAtK?.toFixed(2), precision: s.precision?.toFixed(2) })));
    console.log(`macro recall@k ${macroRecallAtK.toFixed(3)} (floor ${floors.macroRecallAtK}); mean worker precision ${meanWorkerPrecision.toFixed(3)} (floor ${floors.meanWorkerPrecision})`);
    if (process.env.BENCH_OUT) {
      mkdirSync(process.env.BENCH_OUT, { recursive: true });
      writeFileSync(join(process.env.BENCH_OUT, 'layer-a.json'), `${JSON.stringify({ floors, macroRecallAtK, meanWorkerPrecision, queries: scores }, null, 2)}\n`);
    }
    expect(macroRecallAtK).toBeGreaterThanOrEqual(floors.macroRecallAtK);
    expect(meanWorkerPrecision).toBeGreaterThanOrEqual(floors.meanWorkerPrecision);
  });
});
