import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { canMerge, hasChanges, NodeMeta } from './Bits';
import { worktreeCloses } from './Dialogs';
import { mk } from './fixtures';

vi.mock('./conn', () => ({ send: vi.fn() }));

const wt = { repo: '/r', path: '/r/.claude/worktrees/n-3f2a9c1d', branch: 'tl/n-3f2a9c1d', base: 'main', baseSha: 'abc' };

describe('worktree', () => {
  it('the meta line leads with the branch, base in its title, and marks a missing tree', () => {
    const html = renderToStaticMarkup(<NodeMeta node={{ ...mk('a', null, 0, { model: 'claude-opus-5-5' }), worktree: wt }} />);
    expect(html).toMatch(/^<div class="meta"><span class="part"><span class="branch" title="branch tl\/n-3f2a9c1d from main">⎇ tl\/n-3f2a9c1d<\/span>/);
    expect(html).not.toContain('missing');
    expect(renderToStaticMarkup(<NodeMeta node={{ ...mk('a', null, 0), worktree: { ...wt, missing: true } }} />)).toContain('<span class="warn"');
  });

  it('shows ahead, dirty and merged; marks changes only once the work stops, and offers Merge only with commits, a clean worktree and no turn running', () => {
    const git = { branch: wt.branch, base: 'main', ahead: 2, behind: 0, dirty: 1, additions: 0, deletions: 0 };
    const node = (status: object) => ({ ...mk('a', null, 0, { state: 'done', git, ...status }), worktree: wt });
    const text = (n: ReturnType<typeof node>) => renderToStaticMarkup(<NodeMeta node={n} />).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    expect(text(node({}))).toBe('⎇ tl/n-3f2a9c1d ↑2 ●1');
    expect(text(node({ git: { ...git, ahead: 0, dirty: 0, mergedAt: 1 } }))).toBe('⎇ tl/n-3f2a9c1d merged');
    expect([node({}), node({ state: 'working' }), node({ state: 'working', exited: true }), node({ git: { ...git, mergedAt: 1 } })].map(hasChanges)).toEqual([true, false, true, false]);
    const clean = { ...git, dirty: 0 };
    expect([node({ git: clean }), node({}), node({ git: clean, state: 'working' }), node({ git: { ...clean, ahead: 0 } }), node({ git: { ...clean, mergedAt: 1 } })].map(canMerge)).toEqual([true, false, false, false, false]);
  });

  it('the close dialog sends no worktree option for Close, keep for Keep branch, discard for Discard', () => {
    expect(worktreeCloses('n1').map((c) => [c.label, c.msg])).toEqual([
      ['Close', { t: 'close', id: 'n1' }],
      ['Keep branch', { t: 'close', id: 'n1', worktree: 'keep' }],
      ['Discard', { t: 'close', id: 'n1', worktree: 'discard' }],
    ]);
  });
});
