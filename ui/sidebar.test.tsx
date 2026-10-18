import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sidebar, readSidebarDetails, saveSidebarDetails } from './Sidebar';
import { SidebarInspector } from './SidebarInspector';
import { App } from './App';
import { NodeRow } from './NodeRow';
import { SessionSwitcher } from './SessionSwitcher';
import { RenameInput } from './RenameInput';
import { getState, setRenaming, update } from './store';
import { send } from './conn';
import { mk } from './fixtures';
import type { NodeView } from '../src/shared/protocol';
import { flattenSession } from './tree';

const hooks = vi.hoisted(() => ({ open: false, setOpen: vi.fn(), effects: [] as (() => unknown)[], refs: [] as { current: unknown }[] }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useState: () => [hooks.open, hooks.setOpen], useRef: () => hooks.refs.shift() ?? ({ current: null }), useMemo: (fn: () => unknown) => fn(), useEffect: (fn: () => unknown) => hooks.effects.push(fn) }));
vi.mock('./store', async (original) => {
  const store = await original<typeof import('./store')>();
  return { ...store, useStore: (select: (state: ReturnType<typeof store.getState>) => unknown) => select(store.getState()) };
});
vi.mock('./conn', () => ({ send: vi.fn() }));
vi.mock('./SidebarInspector', () => ({ SidebarInspector: () => null }));
vi.mock('./TerminalPane', () => ({ TerminalPane: () => null }));
vi.mock('./hooks', () => ({ useNow: () => 10_000, useDocumentSync: () => {} }));
type Element = ReactElement<Record<string, any>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function find(node: ReactNode, match: (el: Element) => boolean): Element {
  const el = elements(node).find(match);
  if (!el) throw Error('Missing control');
  return el;
}
const a = { ...mk('a', null, 1), cwd: '/current/root' };
const b = { ...mk('b', null, 2), cwd: '/other/root' };
const child = { ...mk('child', 'a', 3), cwd: '/child/worktree' };
beforeEach(() => {
  vi.clearAllMocks(); hooks.open = false; hooks.effects.length = 0; hooks.refs.length = 0;
  update(() => ({ nodes: { a, b, child }, order: ['a', 'child', 'b'], selected: 'child', session: 'a', collapsed: [], opened: [], historyOpen: false, renaming: null, dialog: null }));
});

it('offers a single New session action with the current root cwd, even when a child is selected', () => {
  const switcher = SessionSwitcher();
  find(switcher, (el) => el.props.className === 'btn new-session').props.onClick();
  expect(getState().dialog).toEqual({ kind: 'spawn', parentId: null, cwd: a.cwd });
  expect(renderToStaticMarkup(<SessionSwitcher />).match(/>New session</g)).toHaveLength(1);
  update(() => ({ nodes: {}, order: [], session: null }));
  find(SessionSwitcher(), (el) => el.props.className === 'btn new-session').props.onClick();
  expect(getState().dialog).toEqual({ kind: 'spawn', parentId: null, cwd: '' });
});

it('opens session navigation from the keyboard, switches roots, and closes the menu', () => {
  const preventDefault = vi.fn();
  find(SessionSwitcher(), (el) => el.props.className === 'current').props.onKeyDown({ key: 'ArrowDown', preventDefault });
  expect(preventDefault).toHaveBeenCalled(); expect(hooks.setOpen).toHaveBeenCalledWith(true);
  hooks.open = true;
  const options = elements(SessionSwitcher()).filter((el) => el.props.role === 'menuitemradio');
  expect(options.map((el) => el.props['aria-checked'])).toEqual([true, false]);
  options[1].props.onClick();
  expect(getState().session).toBe('b'); expect(getState().selected).toBe('b');
  expect(hooks.setOpen).toHaveBeenLastCalledWith(false);
});

it('supports wrapping arrow navigation and Home/End within the session menu', () => {
  hooks.open = true;
  const items = [{ focus: vi.fn() }, { focus: vi.fn() }, { focus: vi.fn() }];
  const menu = find(SessionSwitcher(), (el) => el.props.role === 'menu');
  for (const [key, current, next] of [['ArrowUp', 0, 2], ['ArrowDown', 2, 0], ['Home', 1, 0], ['End', 1, 2]] as const) {
    const preventDefault = vi.fn();
    menu.props.onKeyDown({ key, target: items[current], currentTarget: { querySelectorAll: () => items }, preventDefault });
    expect(items[next].focus).toHaveBeenCalled(); expect(preventDefault).toHaveBeenCalled();
  }
});

it('keeps Settings, History, and Clear exited reachable without a redundant footer New child', () => {
  const settings = vi.fn();
  const exited = mk('exited', 'a', 0, { exited: true });
  update((s) => ({ nodes: { ...s.nodes, exited }, order: [...s.order, exited.id] }));
  const sidebar = Sidebar({ onSettings: settings });
  const footer = find(sidebar, (el) => el.type === 'footer');
  const buttons = elements(footer).filter((el) => el.type === 'button');
  buttons[0].props.onClick(); expect(settings).toHaveBeenCalledOnce();
  buttons[1].props.onClick(); expect(send).toHaveBeenCalledWith({ t: 'prune' });
  buttons[2].props.onClick(); expect(getState().historyOpen).toBe(true);
  expect(JSON.stringify(footer)).not.toContain('New child');
});

it('preserves tree keyboard selection and collapse, while ignoring rename input keys', () => {
  update(() => ({ selected: 'a' }));
  const tree = () => find(Sidebar({ onSettings: () => {} }), (el) => el.props.role === 'tree');
  const focus = vi.fn();
  const key = (value: string, tagName = 'DIV') => tree().props.onKeyDown({ key: value, target: { closest: () => tagName === 'INPUT' ? {} : null }, currentTarget: { querySelectorAll: () => [{ dataset: { id: getState().selected }, focus }] }, preventDefault: vi.fn() });
  key('ArrowLeft'); expect(getState().collapsed).toEqual(['a']);
  key('ArrowRight'); expect(getState().collapsed).toEqual([]);
  key('j'); expect(getState().selected).toBe('child'); expect(focus).toHaveBeenCalledOnce();
  key('k', 'INPUT'); expect(getState().selected).toBe('child');
  key('k'); expect(getState().selected).toBe('a');
});

it('retains collapsed descendant attention, gate, unmerged and errored signals with accessible depth', () => {
  const node = { ...a, gate: 'failed' as const, status: { ...a.status, state: 'done' as const, errored: true, git: { branch: 'tl/a', base: 'main', ahead: 1, behind: 0, dirty: 0, additions: 2, deletions: 0 } } };
  const blocked = mk('blocked', 'a', 2, { state: 'blocked' });
  update(() => ({ nodes: { a: node, blocked }, order: ['a', 'blocked'], selected: 'a', collapsed: ['a'] }));
  const row = flattenSession(getState().nodes, getState().order, 'a', ['a'])[0];
  const html = renderToStaticMarkup(<NodeRow row={row} />);
  for (const text of ['aria-level="1"', 'aria-expanded="false"', 'gate failed', 'changes', '1 needs you', 'errored']) expect(html).toContain(text);
  const caret = find(NodeRow({ row }), (el) => el.props['aria-label'] === 'Expand');
  caret.props.onClick({ stopPropagation: vi.fn() });
  expect(getState().collapsed).toEqual([]);
});

it('preserves inline rename commit and cancellation handlers', () => {
  setRenaming(child.id);
  const input = RenameInput({ id: child.id, title: child.title });
  input.props.onKeyDown({ key: 'Enter', currentTarget: { value: '  New title  ' }, stopPropagation: vi.fn() });
  expect(send).toHaveBeenCalledWith({ t: 'rename', id: child.id, title: 'New title' });
  expect(getState().renaming).toBeNull();
  vi.clearAllMocks(); setRenaming(child.id);
  input.props.onKeyDown({ key: 'Escape', stopPropagation: vi.fn() });
  expect(getState().renaming).toBeNull(); expect(send).not.toHaveBeenCalled();
});

it('gives the selected leaf a roving tab stop and selects a directly focused row', () => {
  const rows = flattenSession(getState().nodes, getState().order, 'a', []);
  expect(NodeRow({ row: rows[0] }).props.tabIndex).toBe(-1);
  expect(NodeRow({ row: rows[1] }).props.tabIndex).toBe(0);
  const root = NodeRow({ row: rows[0] });
  const target = {};
  root.props.onFocus({ target, currentTarget: target });
  expect(getState().selected).toBe('a');
  expect(NodeRow({ row: rows[0] }).props.tabIndex).toBe(0);
  expect(NodeRow({ row: rows[1] }).props.tabIndex).toBe(-1);
});

it.each(['button', 'input', 'textarea', 'select', 'menu'])('leaves nested %s navigation to that control', () => {
  const tree = find(Sidebar({ onSettings: () => {} }), (el) => el.props.role === 'tree');
  const preventDefault = vi.fn();
  tree.props.onKeyDown({ key: 'ArrowUp', target: { closest: () => ({}) }, preventDefault });
  expect(preventDefault).not.toHaveBeenCalled();
  expect(getState().selected).toBe('child');
});

it('keeps an entry tab stop when the selected descendant is collapsed out of the tree', () => {
  update(() => ({ collapsed: ['a'] }));
  const sidebar = Sidebar({ onSettings: () => {} });
  const rows = elements(sidebar).filter((el) => el.type === NodeRow);
  expect(rows).toHaveLength(1);
  expect(rows[0].props.tabStop).toBe(true);
  expect(find(sidebar, (el) => el.props.role === 'tree').props.tabIndex).toBe(-1);
});

it('guides the empty state to the single sidebar New session action', () => {
  update(() => ({ nodes: {}, order: [], selected: null, session: null, archived: null }));
  const empty = find(App(), (el) => el.props.className === 'empty');
  expect(elements(empty).filter((el) => el.type === 'button')).toHaveLength(0);
  expect(JSON.stringify(empty.props.children)).toContain('Choose New session in the sidebar to get started.');
});

it.each(['Enter', ' '])('selects the focused row with %j without scrolling or opening child actions', (key) => {
  const tree = find(Sidebar({ onSettings: () => {} }), (el) => el.props.role === 'tree');
  const preventDefault = vi.fn();
  tree.props.onKeyDown({ key, target: { closest: () => null }, preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(getState().selected).toBe('child');
  expect(getState().dialog).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

it('moves direct tree-row focus to the row selected by Cmd+number before subsequent navigation', () => {
  update(() => ({ selected: 'a' }));
  let shortcut: (event: Record<string, unknown>) => void = () => {};
  vi.stubGlobal('addEventListener', (_type: string, handler: typeof shortcut) => { shortcut = handler; });
  App(); hooks.effects.pop()!();
  const active = { getAttribute: () => 'treeitem' };
  vi.stubGlobal('document', { activeElement: active });
  const preventDefault = vi.fn();
  shortcut({ metaKey: true, key: '2', preventDefault });
  expect(getState().selected).toBe('child');
  expect(preventDefault).toHaveBeenCalledOnce();
  const tree = find(Sidebar({ onSettings: () => {} }), (el) => el.props.role === 'tree');
  const selectedRow = { focus: vi.fn(), scrollIntoView: vi.fn() };
  tree.props.ref.current = { querySelector: () => selectedRow, contains: (el: unknown) => el === active };
  hooks.effects.pop()!();
  expect(selectedRow.focus).toHaveBeenCalledOnce();
  expect(selectedRow.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  vi.unstubAllGlobals();
});

it.each(['button', 'input', 'menu', 'terminal'])('selection synchronization preserves nested or external %s focus', (role) => {
  const active = { getAttribute: () => role };
  vi.stubGlobal('document', { activeElement: active });
  const tree = find(Sidebar({ onSettings: () => {} }), (el) => el.props.role === 'tree');
  const selectedRow = { focus: vi.fn(), scrollIntoView: vi.fn() };
  tree.props.ref.current = { querySelector: () => selectedRow, contains: () => role !== 'terminal' };
  hooks.effects.pop()!();
  expect(selectedRow.focus).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it.each([null, '', 'invalid', '1', 'true'])('opens the drawer by default for preference %j', (value) => {
  vi.stubGlobal('localStorage', { getItem: () => value });
  expect(readSidebarDetails()).toBe(true);
  vi.unstubAllGlobals();
});

it('follows selection while open, persists closing across selection and reload, and reopens from the bottom strip', () => {
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
  hooks.open = readSidebarDetails();
  let sidebar = Sidebar({ onSettings: () => {} });
  expect(find(sidebar, (el) => el.type === SidebarInspector).props.node).toBe(child);
  expect(elements(sidebar).some((el) => el.props.className === 'session-activity' || el.props.className === 'details-reopen')).toBe(false);
  update(() => ({ selected: 'a' }));
  sidebar = Sidebar({ onSettings: () => {} });
  expect(find(sidebar, (el) => el.type === SidebarInspector).props.node).toBe(a);
  find(sidebar, (el) => el.type === SidebarInspector).props.onClose();
  expect(hooks.setOpen).toHaveBeenLastCalledWith(false);
  expect(stored.get('tl.sidebarDetails')).toBe('0');
  hooks.open = readSidebarDetails();
  update(() => ({ selected: 'child' }));
  sidebar = Sidebar({ onSettings: () => {} });
  expect(elements(sidebar).some((el) => el.type === SidebarInspector)).toBe(false);
  const reopen = find(sidebar, (el) => el.props.className === 'details-reopen');
  expect(reopen.props['aria-expanded']).toBe(false);
  reopen.props.onClick();
  expect(hooks.setOpen).toHaveBeenLastCalledWith(true);
  expect(stored.get('tl.sidebarDetails')).toBe('1');
  hooks.open = readSidebarDetails();
  expect(find(Sidebar({ onSettings: () => {} }), (el) => el.type === SidebarInspector).props.node).toBe(child);
  update(() => ({ historyOpen: true }));
  expect(elements(Sidebar({ onSettings: () => {} })).some((el) => el.type === SidebarInspector || el.props.role === 'tree')).toBe(false);
  expect(readSidebarDetails()).toBe(true);
  vi.unstubAllGlobals();
});

it('focuses the mounted drawer only after an explicit reopen and restores the mounted strip on close', () => {
  const strip = { focus: vi.fn() }, separator = { focus: vi.fn() };
  const buttonRef = { current: strip }, requested = { current: false };
  const treeRef = { current: { parentElement: { querySelector: vi.fn(() => separator) } } };
  const render = (open: boolean) => {
    hooks.open = open;
    hooks.refs.push(buttonRef, requested, treeRef);
    const sidebar = Sidebar({ onSettings: () => {} });
    return { sidebar, focusEffect: hooks.effects.at(-2)! };
  };
  const initial = render(true);
  initial.focusEffect();
  expect(separator.focus).not.toHaveBeenCalled();
  find(initial.sidebar, (el) => el.type === SidebarInspector).props.onClose();
  const closed = render(false);
  closed.focusEffect();
  expect(strip.focus).toHaveBeenCalledOnce();
  find(closed.sidebar, (el) => el.props.className === 'details-reopen').props.onClick();
  const reopened = render(true);
  reopened.focusEffect();
  expect(separator.focus).toHaveBeenCalledOnce();
  expect(requested.current).toBe(false);
});

it('defaults open when storage is unavailable and tolerates saving', () => {
  vi.stubGlobal('localStorage', { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } });
  expect(readSidebarDetails()).toBe(true);
  expect(() => saveSidebarDetails(false)).not.toThrow();
  vi.unstubAllGlobals();
});

it('shows reported model, effort and context on agent rows and falls back to launch configuration', () => {
  const configured = { ...child, kind: 'agent' as const, harness: 'codex' as const, model: 'gpt-6.1-sol', effort: 'high' as const };
  const output = (node: NodeView) => renderToStaticMarkup(<NodeRow row={{ node, depth: 1, hasChildren: false, collapsed: false, descendants: [], guides: [], last: true }} />);
  let html = output(configured);
  for (const value of ['gpt-6.1-sol', '>high<', '>working<']) expect(html).toContain(value);
  html = output({ ...configured, status: { ...configured.status, model: 'claude-sonnet-5-5', effort: 'medium', contextPct: 0 } });
  for (const value of ['sonnet 5.5', '>med<', '0%']) expect(html).toContain(value);
  expect(html).not.toContain('gpt-6.1-sol');
  html = output({ ...configured, status: { ...configured.status, git: { branch: 'tl/reported-branch', base: 'main', ahead: 0, behind: 0, dirty: 0, additions: 0, deletions: 0 } } });
  expect(html).toContain('>tl/reported-branch<');
  html = output({ ...configured, model: undefined, effort: undefined });
  expect(html).toContain('>codex<');
  expect(html).not.toContain('row-effort'); expect(html).not.toContain('class="ctx');
  const terminal = { ...configured, kind: 'terminal' as const, status: { ...configured.status, state: 'none' as const } };
  html = renderToStaticMarkup(<NodeRow row={{ node: terminal, depth: 0, hasChildren: false, collapsed: false, descendants: [], guides: [], last: true }} />);
  expect(html).toContain('terminal ·');
  expect(html).not.toContain('row-meta');
});

it('keeps reported outcomes distinct from process state and gate, and surfaces hidden unread and stalled activity', () => {
  const node = { ...a, gate: 'running' as const, outcome: { outcome: 'failed' as const, summary: 'Needs another attempt', at: 0 }, worktree: { branch: 'tl/a', base: 'main', baseSha: 'abc', repo: '/repo', path: '/gone', missing: true } };
  const hidden = { ...child, unread: true, status: { ...child.status, stalled: true } };
  update(() => ({ nodes: { a: node, child: hidden }, order: ['a', 'child'], collapsed: ['a'] }));
  const row = flattenSession(getState().nodes, getState().order, 'a', ['a'])[0];
  const html = renderToStaticMarkup(<NodeRow row={row} />);
  for (const text of ['outcome failed', 'gate running', 'working', 'worktree missing', 'unread', 'stalled below']) expect(html).toContain(text);
});

it('keeps Cmd+0 as the tree entry point without selecting or opening node actions', () => {
  let shortcut: (event: Record<string, unknown>) => void = () => {};
  vi.stubGlobal('addEventListener', (_type: string, handler: typeof shortcut) => { shortcut = handler; });
  App(); hooks.effects.pop()!();
  const focus = vi.fn(); const querySelector = vi.fn(() => ({ focus }));
  vi.stubGlobal('document', { querySelector });
  const preventDefault = vi.fn();
  shortcut({ metaKey: true, key: '0', preventDefault });
  expect(querySelector).toHaveBeenCalledWith('.tree');
  expect(focus).toHaveBeenCalledOnce();
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(getState().selected).toBe('child');
  expect(getState().dialog).toBeNull();
  vi.unstubAllGlobals();
});
