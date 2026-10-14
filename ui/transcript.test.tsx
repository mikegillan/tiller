import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Transcript } from '../src/shared/protocol';
import { followupMsg, forkMsg } from './Dialogs';
import { branchLine } from './History';
import { TranscriptView } from './TranscriptPane';

vi.mock('./conn', () => ({ send: vi.fn() }));
vi.mock('./hooks', () => ({ useNow: () => 0 })); // hooks.ts reaches for window on import

const data: Transcript = {
  entries: [
    { role: 'user', at: 1_700_000_000_000, text: 'Fix the handshake.' },
    { role: 'assistant', text: 'Reading it first.', tools: ['Read', 'Grep'] },
    { role: 'assistant', text: 'x\n'.repeat(30) },
  ],
  sessions: [{ sessionId: 'abcdef0123456789', current: true }],
};
const render = (d: Transcript) => renderToStaticMarkup(<TranscriptView data={d} onSession={() => {}} />);

describe('transcript', () => {
  it('renders user and assistant turns apart, tool chips, a time where there is one, and clamps long text', () => {
    const html = render(data);
    expect(html.match(/<article class="entry \w+"/g)).toEqual(['<article class="entry user"', '<article class="entry assistant"', '<article class="entry assistant"']);
    expect(html).toContain('<div class="tools"><span class="chip">Read</span><span class="chip">Grep</span></div>');
    expect(html.match(/<time /g)).toHaveLength(1);
    expect(html.match(/class="text clamped"/g)).toHaveLength(1);
    expect(html).toContain('Show more');
  });

  it('shows the session picker only with more than one session, current first and others by short id', () => {
    expect(render(data)).not.toContain('<select');
    const html = render({ ...data, sessions: [...data.sessions, { sessionId: '5a4b3c2d-7777-8888', current: false }] });
    expect(html).toMatch(/<select[^>]*><option value="" selected="">Current session<\/option><option value="5a4b3c2d-7777-8888">Session 5a4b3c2d<\/option><\/select>/);
  });

  it('follow-up sends the archived id and prompt; fork sends a claude spawn with fork, in the source directory', () => {
    expect(followupMsg('a-1', 'and the tests')).toEqual({ t: 'followup', id: 'a-1', prompt: 'and the tests' });
    const d = { kind: 'fork' as const, from: 'n-1', title: 'auth', cwd: '/w/auth', parentId: 'root' };
    expect(forkMsg(d, ' try B ', 'use approach B')).toEqual({ t: 'spawn', kind: 'claude', title: 'try B', cwd: '/w/auth', parentId: 'root', fork: 'n-1', prompt: 'use approach B' });
    expect(forkMsg(d, '', ' ')).toEqual({ t: 'spawn', kind: 'claude', title: 'fork of auth', cwd: '/w/auth', parentId: 'root', fork: 'n-1' });
  });

  it('names an archived branch with its fate', () => {
    const a = { id: 'a', rootId: 'r', parentId: null, title: 'a', cwd: '/w', createdAt: 0, closedAt: 1, branch: 'tl/n-123' };
    expect([
      branchLine({ ...a, branchFate: 'merged', base: 'main' }), branchLine({ ...a, branchFate: 'kept' }), branchLine({ ...a, branchFate: 'discarded' }), branchLine(a),
    ]).toEqual(['tl/n-123 merged into main', 'tl/n-123 kept', 'tl/n-123 discarded', 'tl/n-123']);
  });
});
