import { beforeEach, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UpdateStatus } from '../../src/shared/protocol';
import { UpdateDialog } from './UpdateDialog';
import { update } from '../store';
import { send } from '../conn';

vi.mock('../controls/Modal', () => ({ Modal: ({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) => <><h2>{title}</h2>{children}{footer}</> }));
vi.mock('../conn', () => ({ send: vi.fn() }));
vi.mock('../store', async (original) => {
  const store = await original<typeof import('../store')>();
  return { ...store, useStore: (select: (state: ReturnType<typeof store.getState>) => unknown) => select(store.getState()) };
});
const release = { id: 1, tag: 'v0.1.13', name: 'v0.1.13', sha: 'new', tagObject: 'tag', publishedAt: '', body: '## Improvements\n\n- Clearer updates.' };
const base: UpdateStatus = { sha: 'old', runtimeSha: 'old', currentVersion: 'v0.1.12', checkedAt: 1, eligible: true, target: release, releases: [release] };
function render(patch: Partial<UpdateStatus> = {}) {
  update(() => ({ update: { ...base, ...patch } }));
  return renderToStaticMarkup(<UpdateDialog />);
}
beforeEach(() => vi.clearAllMocks());

it('shows release hierarchy, accurate checkout metadata, installation disclosure and conditional resume warning', () => {
  const html = render();
  expect(html).toContain('<h2>Update available</h2>');
  expect(html).toContain('Tiller v0.1.13 is ready to install.');
  expect(html).toContain('Current checkout');
  expect(html).toContain('Checkout <code>old</code>');
  expect(html).toContain('What’s new in v0.1.13');
  expect(html).toContain('Installation details');
  expect(html).toContain('Updating will suspend running agents when Tiller restarts.');
  expect(html).toContain('Their sessions are kept so they can be resumed.');
  expect(html).not.toContain('<details class="update-installation" open');
});

it('only gives dirty-specific remediation for an explicit blocker, including older-daemon fallback', () => {
  const dirty = render({ eligible: false, reason: 'The main checkout is not clean. Move or stash changes, then check releases again.', blocker: 'dirty' });
  expect(dirty).toContain('Save your changes to continue');
  expect(dirty).toContain('Move changes to a task worktree, or stash them, including untracked files.');
  expect(dirty).not.toContain('Move or stash changes');
  expect(dirty).toContain('The main checkout has uncommitted or untracked files.');
  expect(dirty.match(/stash/g)).toHaveLength(1);
  expect(dirty).not.toContain('ready to install');
  expect(dirty.indexOf('update-blocked-reason')).toBeLessThan(dirty.indexOf('What’s new'));
  const generic = render({ eligible: false, reason: 'Cannot fast-forward to the release.' });
  expect(generic).toContain('<h3>Update blocked</h3>');
  expect(generic).not.toContain('stash');
  expect(generic).toContain('aria-describedby="update-blocked-reason" disabled=""');
});

it.each(['checking', 'applying'] as const)('announces %s with indeterminate SVGs and disables both operations', (state) => {
  const html = render({ [state]: true });
  expect(html).toContain(state === 'checking' ? 'Checking for updates…' : 'Installing update…');
  expect(html).toContain('role="status" aria-live="polite"');
  expect(html).toContain('class="update-spinner"');
  expect(html.match(/disabled=""/g)).toHaveLength(2);
  expect(html).not.toContain('%');
});

it('treats daemon refresh ineligibility as checking, hiding stale reasons and blockers until completion', () => {
  const reason = 'The main checkout is not clean. Move or stash changes, then check releases again.';
  const checking = render({ checking: true, eligible: false, reason, blocker: undefined });
  expect(checking).toContain('Checking for updates…');
  expect(checking.match(/disabled=""/g)).toHaveLength(2);
  expect(checking).not.toContain(reason);
  expect(checking).not.toContain('update-blocked-reason');
  expect(checking).not.toContain('Update blocked');
  expect(checking).not.toContain('Save your changes');
  expect(checking).not.toContain('M7 10V7'); // The lock path must not appear during a refresh.
  expect(checking).not.toContain('Resolve the blocker');
  expect(checking).not.toContain('ready to install');
  const completed = render({ checking: false, eligible: false, reason, blocker: 'dirty' });
  expect(completed).toContain('Save your changes');
  expect(render({ checking: false, eligible: true })).toContain('ready to install');
});

it('preserves rebuild-only and distinguishes running daemon from checkout', () => {
  const html = render({ sha: 'new', currentVersion: release.tag });
  expect(html).toContain('Restart required');
  expect(html).toContain('Rebuild and restart');
  expect(html).toContain('this daemon is running old');
  expect(html).not.toContain('ready to install');
});

it('retains failed checks, failed installs, absent targets and up-to-date states', () => {
  const failed = render({ eligible: false, fetchError: 'GitHub is offline', failed: 'Build failed' });
  expect(failed).toContain('role="alert">GitHub is offline');
  expect(failed).toContain('role="alert">Build failed');
  expect(render({ target: undefined, releases: [], eligible: false })).not.toContain('Update v');
  const current = render({ sha: 'new', runtimeSha: 'new', currentVersion: release.tag, releases: [] });
  expect(current).toContain('Your checkout is at the latest stable release.');
  expect(current).not.toContain('Rebuild and restart');
});

// Exercise real action callbacks without adding a DOM dependency.
function buttons(node: ReactNode): ReactElement<{ children?: ReactNode; onClick?: () => void; disabled?: boolean }>[] {
  if (!isValidElement<{ children?: ReactNode; footer?: ReactNode }>(node)) return [];
  return [...(node.type === 'button' ? [node] : []), ...[node.props.children, node.props.footer].flat().flatMap(buttons)];
}
it('sends the reviewed tag and SHA for install and uses the daemon check operation', () => {
  render();
  const controls = buttons(UpdateDialog());
  controls[1].props.onClick!();
  expect(send).toHaveBeenLastCalledWith({ t: 'updateCheck' });
  controls[2].props.onClick!();
  expect(send).toHaveBeenLastCalledWith({ t: 'update', tag: release.tag, sha: release.sha });
});
