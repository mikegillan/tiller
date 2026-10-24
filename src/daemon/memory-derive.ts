// derive(): what memory records from one captured event, given the node's episodes since its previous outcome. Pure: no
// I/O and no clock, so tests and replays run the same code as captureMemory. Trust rules: plan D4 rules 3-5.
import type { ArchivedNode, Outcome } from '../shared/protocol.js';
import { briefOf } from './archive.js';
import {
  firstErrorLine, gateExit, LIMITS, normalizeDedupe, parseItemRef, structuralCode,
  type CaptureEvent, type Derived, type DerivedItem, type EpisodeData, type HistoryEntry, type ItemKind,
} from './memory-schema.js';

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
/** The last max characters, so a gate tail keeps its exit line. */
const cutFront = (s: string, max: number) => (s.length > max ? `…${s.slice(s.length - max + 1)}` : s);
const firstSentence = (s?: string) => {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t && (/^.*?[.!?](?=\s|$)/.exec(t)?.[0] ?? t);
};

function item(kind: ItemKind, text: string, author: DerivedItem['author'], body?: string, dedupe = normalizeDedupe(kind, text)): DerivedItem {
  return { kind, text, ...(body ? { body } : {}), author, dedupe };
}

/** One item per dedupe key, the first kept. */
const distinct = (items: DerivedItem[]) => items.filter((x, i) => items.findIndex((y) => y.kind === x.kind && y.dedupe === x.dedupe) === i);

const TOOLS = new Set(['tsc', 'vitest', 'jest', 'eslint', 'prettier', 'playwright']);
const BANNED_ARGS = /^(?:-e|-c|-p|--eval|--print|--exec)(?:=|$)/;
// git diff --output writes a file; git grep -O runs a pager command.
const GIT_BANNED_ARGS = /^(?:--output|-O|--open-files-in-pager)/;
const SCRIPT = /^[\w:.-]+$/;
const PATH = /^[\w./@-]+$/;
const isScript = (s?: string) => !!s && SCRIPT.test(s) && !s.startsWith('-');
const isPath = (s?: string) => !!s && PATH.test(s) && !s.startsWith('-');

/** Whether a command an agent reported is safe to replay as a procedure: the D4 rule 5 allowlist. */
export function isProcedure(span: string): boolean {
  const cmd = span.trim();
  if (!cmd || cmd.length > LIMITS.procedure.span || /[|;&`<>]|\$\(/.test(cmd)) return false;
  const args = cmd.split(/\s+/);
  const [c, a, b, d] = args;
  if (args.some((x) => BANNED_ARGS.test(x))) return false;
  switch (c) {
    case 'npm': return a === 'test' || a === 't' || ((a === 'run' || a === 'run-script') && isScript(b));
    case 'pnpm': case 'yarn': case 'bun':
      return a === 'test' || (a === 'run' && isScript(b)) || (a === 'exec' && c !== 'bun' && TOOLS.has(b ?? ''));
    case 'npx': return TOOLS.has((a === '--no-install' ? b : a) ?? '');
    case 'node': return (a === '--test' && (b === undefined || isPath(b))) || (isPath(a) && /\.(?:js|mjs|cjs|ts)$/.test(a ?? ''));
    case 'tsx': return isPath(a);
    case 'cargo': return ['test', 'check', 'build', 'clippy', 'fmt'].includes(a ?? '');
    case 'go': return ['test', 'vet', 'build'].includes(a ?? '');
    case 'make': return isScript(a);
    case 'pytest': return true;
    case 'python': case 'python3': return a === '-m' && (b === 'pytest' || b === 'unittest');
    case 'uv': return a === 'run' && b === 'pytest';
    case 'git':
      return ['status', 'diff', 'log', 'show', 'grep', 'ls-files', 'rev-parse', 'blame'].includes(a ?? '') && !args.some((x) => GIT_BANNED_ARGS.test(x));
    case 'tl':
      // sessions clean deletes; only the listing and its path lookup are read-only.
      if (a === 'sessions') return b === undefined || b === 'path';
      if (a === 'memory') return b === 'search' || b === 'show';
      return ['list', 'ps', 'config', 'gate', 'diff', 'history', 'transcript', 'read', 'status', 'log'].includes(a ?? '');
    case 'claude': return a === 'plugin' && (b === 'validate' || b === 'test') && (d === undefined || isPath(d));
    default: return false;
  }
}

/** The outcome's data, cut until its JSON fits LIMITS.outcome.episode: verified, summary, note, then list entries. */
function outcomeData(o: EpisodeData['outcome']): EpisodeData['outcome'] {
  const data = { ...o, ...(o.openQuestions ? { openQuestions: o.openQuestions.slice(0, LIMITS.outcome.openQuestions).map((q) => cut(q, LIMITS.outcome.openQuestion)) } : {}) };
  const excess = () => JSON.stringify(data).length - LIMITS.outcome.episode;
  for (const k of ['verified', 'summary', 'note'] as const) {
    while (excess() > 0 && data[k]) data[k] = data[k].length - excess() - 1 > 0 ? cut(data[k], data[k].length - excess()) : '';
  }
  for (const k of ['changedFiles', 'openQuestions'] as const) while (excess() > 0 && data[k]?.length) data[k] = data[k].slice(0, -1);
  return data;
}

const failures = (history: HistoryEntry[]) =>
  history.flatMap((h) => (h.kind === 'gate' && !h.data.ok ? [h.data] : []));

function outcomeItems(o: EpisodeData['outcome'], history: HistoryEntry[]): DerivedItem[] {
  const items = (o.openQuestions ?? []).slice(0, LIMITS.outcome.openQuestions).map((q) => q.trim()).filter(Boolean)
    .map((q) => item('open_question', cut(q, LIMITS.outcome.openQuestion), 'agent'));
  const succeeded = o.outcome === 'succeeded' && o.gate !== 'failed';
  if (succeeded) {
    for (const [, span] of (o.verified ?? '').matchAll(/`([^`\n]+)`/g)) {
      if (isProcedure(span)) items.push(item('procedure', span.trim().replace(/\s+/g, ' '), 'agent'));
    }
  }
  if (succeeded && o.gate === 'passed') {
    // Gate output is agent text (R2): author agent, eligible only because this node then passed.
    const fixed = o.summary && cut(firstSentence(o.summary)!, LIMITS.item.text);
    for (const f of failures(history)) {
      const line = f.tail && firstErrorLine(f.tail);
      if (!line) continue;
      const note = `\nFixed by this node${fixed ? `: ${fixed}` : ''}`;
      items.push(item('pitfall', cut(`gate \`${f.command}\` failed: ${line}`, LIMITS.item.text), 'agent', cutFront(f.tail ?? '', LIMITS.item.body - note.length) + note));
    }
  }
  const last = failures(history).at(-1);
  if (o.outcome === 'failed' && o.gate === 'failed' && last) {
    // Unresolved: daemon facts only, the command, the daemon's exit line and one structural code.
    const tail = last.tail ?? '';
    const code = structuralCode(tail);
    const facts = [gateExit(tail), code].filter(Boolean).join(' · ');
    const dedupe = `GATE:${normalizeDedupe('pitfall', last.command)}${code ? ` ${code}` : ''}`;
    const note = '\nunresolved';
    items.push(item('pitfall', cut(`gate \`${last.command}\` failed${facts ? ` (${facts})` : ''}`, LIMITS.item.text), 'daemon', cutFront(tail, LIMITS.item.body - note.length) + note, dedupe));
  }
  return distinct(items);
}

/** The ids cited as [m<id>] anywhere in the outcome. */
function citesOf(o: EpisodeData['outcome']): number[] {
  const text = [o.note, o.summary, o.verified, ...(o.changedFiles ?? []), ...(o.openQuestions ?? [])].join('\n');
  return [...new Set([...text.matchAll(/\[m(\d+)\]/g)].map(([, d]) => parseItemRef(`m${d}`)).filter((id) => id !== undefined))];
}

const fateText = (a: ArchivedNode) =>
  a.branchFate === 'merged' ? `merged to task branch ${a.base ?? '?'}` : a.branchFate === 'kept' ? 'branch kept, unmerged' : a.branchFate === 'discarded' ? 'branch discarded' : undefined;
const verdict = (o?: Outcome) => (o ? `${o.outcome}${o.gate ? ` (gate ${o.gate})` : ''}` : 'no outcome');

function ledger(a: ArchivedNode): DerivedItem {
  const title = cut(a.title.replace(/\s+/g, ' ').trim(), LIMITS.item.title);
  const fate = fateText(a);
  const o = a.outcome;
  const succeeded = o?.outcome === 'succeeded' && o.gate !== 'failed';
  const text = succeeded
    ? `${title}: ${briefOf({ ...a, branchFate: undefined }) ?? verdict(o)}${fate ? ` (${fate})` : ''}`
    : `${title}: ${verdict(o)}${fate ? ` · ${fate}` : ''}`;
  const body = [
    a.prompt && cut(a.prompt.trim(), LIMITS.item.ledgerBrief),
    o?.summary,
    o?.changedFiles?.length && `Files: ${o.changedFiles.join(', ')}`,
    o?.verified && `Verified: ${o.verified}`,
  ].filter(Boolean).join('\n\n');
  return item('ledger', cut(text, LIMITS.item.text), succeeded ? 'agent' : 'daemon', cut(body, LIMITS.item.ledgerBody), a.id);
}

/** What one captured event records. history: the node's episodes since its previous outcome, oldest first. */
export function derive(event: CaptureEvent, history: HistoryEntry[]): Derived {
  const { ts } = event;
  switch (event.type) {
    case 'outcome': {
      const { type: _, ts: __, ...o } = event;
      return { episode: { kind: 'outcome', ts, data: outcomeData(o) }, items: outcomeItems(o, history), cites: citesOf(o) };
    }
    case 'gate': {
      const { ok, command, attempt, tail } = event;
      return { episode: { kind: 'gate', ts, data: { ok, command, attempt, ...(!ok && tail ? { tail: cutFront(tail, LIMITS.gateTail) } : {}) } }, items: [], cites: [] };
    }
    case 'close': {
      const a = event.archived;
      const data: EpisodeData['close'] = {
        spentUsd: a.spentUsd, createdAt: a.createdAt, closedAt: a.closedAt, branchFate: a.branchFate, base: a.base, outcome: a.outcome?.outcome, gate: a.outcome?.gate,
      };
      return { episode: { kind: 'close', ts, data }, items: [ledger(a)], cites: [] };
    }
    case 'spawn': { const { type: _, ts: __, ...data } = event; return { episode: { kind: 'spawn', ts, data }, items: [], cites: [] }; }
    case 'merge': { const { type: _, ts: __, ...data } = event; return { episode: { kind: 'merge', ts, data }, items: [], cites: [] }; }
    case 'human_send': { const { type: _, ts: __, ...data } = event; return { episode: { kind: 'human_send', ts, data }, items: [], cites: [] }; }
  }
}
