import { Fragment, type KeyboardEvent } from 'react';
import type { Conversation, ConversationItem, ConversationSummary } from '../../src/shared/protocol';
import { OutcomeDetails } from '../controls/Bits';
import { Select } from '../controls/Select';
import { ClampedText, OutcomeGlyph, Tools, When } from './parts';
import './conversations.css';

/** What the Transcript tab shows: a conversation by its request params, or the full transcript. */
export type Choice = { id: string; with?: string } | 'full';
const keyOf = (c: Choice) => c === 'full' ? 'full' : `${c.id}|${c.with ?? ''}`;
const RELATION = { parent: { glyph: '↑', word: 'parent' }, child: { glyph: '↓', word: 'child' }, peer: { glyph: '↔', word: 'peer' } } as const;
const rowTitle = (c: ConversationSummary) => c.relation === 'parent' && c.counterpart === 'human' ? 'With you' : c.title;
const plural = (n: number) => `${n} message${n === 1 ? '' : 's'}`;

/** Arrow keys move between the rail's buttons. */
function arrows(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const buttons = [...e.currentTarget.querySelectorAll('button')];
  const next = buttons[buttons.indexOf(e.target as HTMLButtonElement) + (e.key === 'ArrowDown' ? 1 : -1)];
  if (next) { e.preventDefault(); next.focus(); }
}

/**
 * A node's conversations (parent, children, peers, as the daemon orders them) and Full transcript: a rail on wide panes,
 * a select on narrow ones (CSS picks which shows).
 */
export function ConversationList({ items, error, selected, onSelect }: { items?: ConversationSummary[]; error?: string; selected: Choice; onSelect: (c: Choice) => void }) {
  const current = keyOf(selected);
  const status = error ?? (items ? undefined : 'Loading conversations…');
  items ??= [];
  const byKey = new Map<string, Choice>([['full', 'full'], ...items.map((c) => [keyOf(c), { id: c.id, with: c.with }] as const)]);
  return (
    <>
      <nav className="convo-rail" aria-label="Conversations" onKeyDown={arrows}>
        <h2>Conversations</h2>
        <ul>
          {items.map((c) => {
            const r = RELATION[c.relation], key = keyOf(c);
            return (
              <li key={key}>
                <button className={`convo-row${key === current ? ' sel' : ''}`} aria-current={key === current} onClick={() => onSelect(byKey.get(key)!)}
                  aria-label={`${rowTitle(c)}, ${r.word}${c.outcome ? `, ${c.outcome}` : ''}, ${plural(c.messages)}${c.live ? ', live' : ''}`}>
                  <span className="rel" aria-hidden>{r.glyph}</span>
                  <span className="title">{rowTitle(c)}</span>
                  {c.relation === 'child' && <OutcomeGlyph o={c.outcome} />}
                  <span className="count" aria-hidden>{c.messages}</span>
                  <span className={`live${c.live ? ' on' : ''}`} aria-hidden title={c.live ? 'live' : undefined} />
                </button>
              </li>
            );
          })}
          {status && <li className="hint">{status}</li>}
          <li className="sep">
            <button className={`convo-row${current === 'full' ? ' sel' : ''}`} aria-current={current === 'full'} onClick={() => onSelect('full')}>
              <span className="rel" aria-hidden>≡</span><span className="title">Full transcript</span>
            </button>
          </li>
        </ul>
      </nav>
      <label className="convo-pick">Conversation
        <Select value={current} onChange={(e) => onSelect(byKey.get(e.target.value) ?? 'full')}>
          {!byKey.has(current) && <option value={current}>{error ? 'Unavailable' : 'Loading…'}</option>}
          {items.map((c) => <option key={keyOf(c)} value={keyOf(c)}>{RELATION[c.relation].glyph} {rowTitle(c)} ({c.messages})</option>)}
          <option value="full">≡ Full transcript</option>
        </Select>
        {error && <span className="hint">{error}</span>}
      </label>
    </>
  );
}

/** "Parent ⇄ subject" (or "a ⇄ b" for peers), with the human as You. */
export const conversationTitle = (c: Conversation) => `${nameIn(c, c.a)} ⇄ ${nameIn(c, c.b)}`;
const nameIn = (c: Conversation, id: string) => id === 'human' ? 'You' : c.titles[id] ?? id;

/**
 * One conversation as two-sided bubbles: `a` (the parent, the human or the first peer) on the left, `b` on the right,
 * daemon notices and lifecycle events centred. `jump` returns how to open a participant's pane, if it can be opened.
 */
export function ConversationView({ data, showTools, jump }: { data: Conversation; showTools: boolean; jump?: (id: string) => (() => void) | undefined }) {
  const who = (id: string, label = nameIn(data, id)) => {
    const go = jump?.(id);
    return go ? <button className="who" onClick={go}>{label}</button> : <span className="who">{label}</span>;
  };
  const side = (from: string) => from === data.b ? 'right' : 'left';
  const item = (it: ConversationItem) => {
    switch (it.kind) {
      case 'brief':
        return (
          <article className={`entry bubble ${side(it.from)}`}>
            <header>{who(it.from)}<span className="chip">brief</span><When at={it.at} /></header>
            <ClampedText text={it.text} />
          </article>
        );
      case 'message': {
        const notice = it.from === 'tiller';
        const queued = it.delivery === 'delivered' && it.at !== it.sentAt;
        return (
          <article className={notice ? 'entry notice' : `entry bubble ${side(it.from)}`}>
            <header>
              {who(it.from, it.label)}
              {it.steer && <span className="chip">steer</span>}
              {it.delivery !== 'delivered' && <span className={`chip delivery ${it.delivery}`}>{it.delivery}</span>}
              {queued ? <span className="times">queued <When at={it.sentAt} /> · delivered <When at={it.at} /></span> : <When at={it.sentAt} />}
            </header>
            {it.text !== undefined ? <ClampedText text={it.text} /> : <p className="placeholder">Sent a message, text not recorded</p>}
          </article>
        );
      }
      case 'turn': {
        const tools = showTools ? it.tools : undefined;
        if (!it.text && !tools?.length) return null;
        return (
          <article className={`entry bubble ${side(it.from)}`}>
            <header>{who(it.from)}{it.at !== undefined && <When at={it.at} />}</header>
            {it.text && <ClampedText text={it.text} />}
            <Tools tools={tools} />
          </article>
        );
      }
      case 'outcome':
        return (
          <article className={`entry bubble ${side(it.from)} report`}>
            <header>{who(it.from)}<span className="chip">outcome</span><When at={it.at} /></header>
            <OutcomeDetails o={it.outcome} />
          </article>
        );
      case 'event':
        return <p className="convo-event"><span>{it.text}</span> <When at={it.at} /></p>;
    }
  };
  // Stable keys, so an expanded "Show more" stays put when older items are dropped from the front.
  const seen = new Map<string, number>();
  const keyFor = (it: ConversationItem) => {
    if (it.kind === 'message') return it.messageId;
    const base = `${it.kind}|${it.at ?? ''}`, n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}|${n}`;
  };
  return (
    <>
      {data.truncated && <p className="hint">Older messages are not shown.</p>}
      {data.items.map((it) => <Fragment key={keyFor(it)}>{item(it)}</Fragment>)}
      {!data.items.length && <p className="hint">No messages yet.</p>}
    </>
  );
}
