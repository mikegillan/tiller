import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { SettingsPanel } from './SettingsPanel';
import { claudeRecommendations, type SettingsSnapshot } from './settings-model';

// Exercise the component's real handlers and asynchronous requests without a DOM dependency.
// Effects are flushed after each render; DOM focus/dialog behavior is verified in the browser.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, deps: [] as unknown[][], effects: [] as (() => unknown)[] }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = initial;
    return [hooks.slots[i], (next: unknown) => { hooks.slots[i] = typeof next === 'function' ? next(hooks.slots[i]) : next; }];
  },
  useRef: () => ({ current: null }),
  useEffect: (effect: () => unknown, deps: unknown[]) => {
    const i = hooks.cursor++;
    if (!hooks.deps[i] || deps.some((value, j) => value !== hooks.deps[i][j])) { hooks.deps[i] = deps; hooks.effects.push(effect); }
  },
}));
vi.mock('./store', () => ({ useStore: (select: (s: unknown) => unknown) => select({ connected: false }) }));
vi.mock('./conn', () => ({ refreshUsage: vi.fn() }));
vi.mock('./url', () => ({ token: () => 'test' }));
const snapshot: SettingsSnapshot = { scope: 'project', path: '/repo/.tiller/config.json', projectPath: '/repo', revision: 'r1', values: { 'profiles.claude.implementation.model': 'custom' }, entries: { 'profiles.claude.implementation.model': { value: 'custom', source: '/repo/.tiller/config.json' } }, inherited: { 'profiles.claude.implementation.model': { value: 'legacy-worker', source: '/home/config.json' } } };
let tree: ReactElement;
const close = vi.fn();
const fetchMock = vi.fn(async (_url: unknown, options?: RequestInit) => {
  const scope = String(_url).includes('scope=home') ? 'home' : 'project';
  return { ok: true, json: async () => ({ ...snapshot, scope, ...(options?.method === 'POST' ? { revision: 'r2' } : {}) }) };
});
function render() { hooks.cursor = 0; tree = SettingsPanel({ nodeId: 'n1', onClose: close }); hooks.effects.splice(0).forEach((effect) => effect()); }
async function settle() { await vi.waitFor(() => { render(); expect(elements(tree).some((e) => e.type === 'form')).toBe(true); expect(button('Close').props.disabled).toBe(false); }); }
type Element = ReactElement<Record<string, any>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child));
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function text(node: ReactNode): string { return Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' && 'props' in node ? text((node as Element).props.children) : typeof node === 'string' ? node : ''; }
function button(label: string) { const match = elements(tree).find((e) => e.type === 'button' && text(e.props.children) === label); if (!match) throw Error(`Missing button ${label}`); return match; }
function click(label: string) { button(label).props.onClick(); render(); }
function input(id: string) { return elements(tree).find((e) => e.props.id === `setting-${id}`)!; }
async function submit() { await elements(tree).find((e) => e.type === 'form')!.props.onSubmit({ preventDefault() {} }); await settle(); }
beforeEach(async () => { hooks.slots = []; hooks.deps = []; hooks.effects = []; close.mockClear(); fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('document', { activeElement: null }); render(); await settle(); });

it('guards scope changes and closing, keeps edits on request, and discards only with explicit action', async () => {
  input('profiles.claude.implementation.model').props.onChange({ target: { value: 'edited' } }); render();
  click('Global · all repositories');
  expect(text(tree)).toContain('Discard unsaved changes?');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  click('Keep editing');
  expect(input('profiles.claude.implementation.model').props.value).toBe('edited');
  click('Close'); expect(close).not.toHaveBeenCalled();
  click('Keep editing'); click('Global · all repositories'); click('Discard changes'); await settle();
  expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/settings?scope=home');
  expect(button('Save global settings').props.disabled).toBe(true);
  expect(text(tree)).toContain('Daemon (global only)');
});

it('previews a reset using the server fallback and sends only the removed repository override', async () => {
  const reset = elements(tree).find((e) => e.type === 'button' && e.props['aria-label'] === 'Remove repository override: Implementation model')!;
  reset.props.onClick(); render();
  expect(input('profiles.claude.implementation.model').props.value).toBe('legacy-worker');
  expect(text(tree)).toContain('After save: legacy-worker');
  await submit();
  const body = JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')?.[1]?.body));
  expect(body).toEqual({ scope: 'project', nodeId: 'n1', revision: 'r1', changes: { 'profiles.claude.implementation.model': null } });
});

it('stages Claude recommendations without saving, retains other category drafts, and saves all edited fields', async () => {
  click('Limits'); // Inherited fields require customization first.
  const customize = elements(tree).find((e) => e.type === 'button' && e.props['aria-label'] === 'Customize for this repository: Max Depth')!;
  customize.props.onClick(); render(); input('limits.maxDepth').props.onChange({ target: { value: '4' } }); render();
  click('Claude'); click('Stage recommended Claude defaults');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(input('profiles.claude.implementation.model').props.value).toBe('sonnet');
  expect(text(tree)).toContain('After save: opus');
  await submit();
  const body = JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')?.[1]?.body));
  expect(body.changes).toEqual({ ...claudeRecommendations, 'limits.maxDepth': 4 });
  expect(button('Save repository settings').props.disabled).toBe(true);
});

it('can cancel staged defaults, and global saves omit the repository node', async () => {
  click('Stage recommended Claude defaults'); click('Cancel changes');
  expect(input('profiles.claude.implementation.model').props.value).toBe('custom');
  click('Global · all repositories'); await settle(); click('Stage recommended Claude defaults'); await submit();
  const body = JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')?.[1]?.body));
  expect(body).toEqual({ scope: 'home', revision: 'r1', changes: claudeRecommendations });
});

it('retains drafts and disables saving on a revision conflict until reload', async () => {
  click('Stage recommended Claude defaults');
  fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 409, json: async () => ({ error: 'File changed on disk' }) } as any));
  await submit();
  expect(text(tree)).toContain('File changed on disk');
  expect(input('profiles.claude.implementation.model').props.value).toBe('sonnet');
  expect(button('Save repository settings').props.disabled).toBe(true);
  click('Reload latest settings'); await settle();
  expect(input('profiles.claude.implementation.model').props.value).toBe('custom');
});


it('withholds stale profile reset and inherited previews while a legacy model draft is pending', async () => {
  click('Legacy Claude roles');
  elements(tree).find((e) => e.type === 'button' && e.props['aria-label'] === 'Customize for this repository: Worker model')!.props.onClick(); render();
  input('roles.worker.model').props.onChange({ target: { value: 'haiku' } }); render();
  click('Claude');
  // The still-explicit profile remains accurate despite role edits.
  expect(input('profiles.claude.implementation.model').props.value).toBe('custom');
  elements(tree).find((e) => e.type === 'button' && e.props['aria-label'] === 'Remove repository override: Implementation model')!.props.onClick(); render();
  expect(input('profiles.claude.implementation.model').props.value).toBe('');
  expect(text(tree)).toContain('Preview unavailable until legacy role changes are saved.');
  expect(text(tree)).not.toContain('After save: legacy-worker');
  await submit();
  const body = JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')?.[1]?.body));
  expect(body.changes).toEqual({ 'roles.worker.model': 'haiku', 'profiles.claude.implementation.model': null });
});

it('stages Claude models while retaining a separately configured effort draft', async () => {
  elements(tree).find((e) => e.type === 'button' && e.props['aria-label'] === 'Customize for this repository: Implementation effort')!.props.onClick(); render();
  input('profiles.claude.implementation.effort').props.onChange({ target: { value: 'max' } }); render();
  click('Stage recommended Claude defaults');
  expect(input('profiles.claude.implementation.effort').props.value).toBe('max');
  expect(text(tree)).toContain('CLI default when unset');
  expect(text(tree)).toContain('Staging changes models only and retains every configured effort.');
  await submit();
  const body = JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')?.[1]?.body));
  expect(body.changes).toEqual({ ...claudeRecommendations, 'profiles.claude.implementation.effort': 'max' });
});
