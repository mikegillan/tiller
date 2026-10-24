import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConversationSummary } from '../../src/shared/protocol';
import { conversation } from '../fixtures';
import { ConversationList, ConversationView } from './Conversations';

const view = (showTools = false, jump?: (id: string) => (() => void) | undefined) =>
  renderToStaticMarkup(<ConversationView data={conversation} showTools={showTools} jump={jump} />);
const articles = (html: string) => html.match(/<article class="[^"]+"/g)?.map((a) => a.slice(16, -1));

describe('conversation view', () => {
  it('puts the parent on the left, the subject on the right, and a daemon notice in the middle', () => {
    expect(articles(view())).toEqual([
      'entry bubble left',   // brief
      'entry bubble right',  // assistant turn with text (the tool-only one is hidden)
      'entry bubble right',  // worker → parent
      'entry bubble left',   // parent → worker, queued then delivered
      'entry bubble left',   // still queued
      'entry bubble right',  // legacy, no text
      'entry bubble right report',
      'entry notice',
    ]);
    expect(view()).toContain('<p class="convo-event"><span>merged tl/w into main</span>');
  });

  it('shows both times for a queued-then-delivered message, a chip only when not simply delivered, and the legacy placeholder', () => {
    const html = view();
    expect(html).toMatch(/<span class="times">queued <time[^>]*>[^<]+<\/time> · delivered <time/);
    expect(html.match(/class="chip delivery[^"]*"/g)).toEqual(['class="chip delivery queued"']);
    expect(html).toContain('<p class="placeholder">Sent a message, text not recorded</p>');
    expect(html).toContain('<div class="verdict succeeded">Succeeded</div>');
  });

  it('hides tool chips and tool-only turns unless showTools', () => {
    expect(view()).not.toContain('class="chip">Read');
    expect(view()).not.toContain('class="tools"');
    const shown = view(true);
    expect(shown).toContain('<div class="tools"><span class="chip">Read</span><span class="chip">Grep</span></div>');
    expect(shown).toContain('<div class="tools"><span class="chip">Bash</span></div>');
    expect(articles(shown)).toHaveLength(9);
  });

  it('names participants by title, as jump buttons where they can be opened, and renders text as plain text', () => {
    const html = view(false, (id) => id === 'root' ? () => {} : undefined);
    expect(html).toContain('<button class="who">tiller</button>');
    expect(html).toContain('<span class="who">probes</span>');
    const hostile = renderToStaticMarkup(<ConversationView data={{ ...conversation, items: [{ kind: 'brief', at: 0, from: 'root', text: '<img src=x onerror=alert(1)>' }] }} showTools={false} />);
    expect(hostile).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(hostile).not.toContain('<img');
  });
});

describe('conversation list', () => {
  const items: ConversationSummary[] = [
    { id: 'n', relation: 'parent', counterpart: 'human', title: 'you', live: true, messages: 12 },
    { id: 'c1', relation: 'child', counterpart: 'c1', title: 'Coalesce probes', live: false, messages: 4, outcome: 'succeeded' },
    { id: 'c2', relation: 'child', counterpart: 'c2', title: 'Review PR', live: true, messages: 2 },
    { id: 'n', with: 'p', relation: 'peer', counterpart: 'p', title: 'Quick wins', live: true, messages: 1 },
  ];
  const html = renderToStaticMarkup(<ConversationList items={items} selected={{ id: 'n' }} onSelect={() => {}} />);

  it('shows relation glyphs, outcome glyphs for children, counts, live dots, and Full transcript last', () => {
    const rows = [...html.matchAll(/<button class="convo-row[^"]*"[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, '|').replace(/\|+/g, '|'));
    expect(rows).toEqual(['|↑|With you|12|', '|↓|Coalesce probes|✓|4|', '|↓|Review PR|·|2|', '|↔|Quick wins|1|', '|≡|Full transcript|']);
    expect(html.match(/class="live on"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Coalesce probes, child, succeeded, 4 messages"');
  });

  it('marks the selection in the rail and the narrow-pane select', () => {
    expect(html).toMatch(/<button class="convo-row sel" aria-current="true"[^>]*aria-label="With you/);
    expect(html).toMatch(/<option value="n\|" selected="">↑ With you \(12\)<\/option>/);
    expect(html).toContain('<nav class="convo-rail" aria-label="Conversations">');
  });

  it('shows loading and a list error in both the rail and the narrow-pane select', () => {
    const loading = renderToStaticMarkup(<ConversationList selected={{ id: 'n' }} onSelect={() => {}} />);
    expect(loading).toContain('<li class="hint">Loading conversations…</li>');
    expect(loading).toContain('<option value="n|" selected="">Loading…</option>');
    const failed = renderToStaticMarkup(<ConversationList error="no such node: n" selected={{ id: 'n' }} onSelect={() => {}} />);
    expect(failed).toContain('<li class="hint">no such node: n</li>');
    expect(failed).toContain('<option value="n|" selected="">Unavailable</option>');
    expect(failed).toContain('<span class="hint">no such node: n</span>');
  });
});
