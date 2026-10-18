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
import { flattenSession } from './tree';

const hooks = vi.hoisted(() => ({ open: false, setOpen: vi.fn(), effects: [] as (() => unknown)[] }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useState: () => [hooks.open, hooks.setOpen], useRef: () => ({ current: null }), useMemo: (fn: () => unknown) => fn(), useEffect: (fn: () => unknown) => hooks.effects.push(fn) }));
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
  vi.clearAllMocks(); hooks.open = false; hooks.effects.length = 0;
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

it('counts all session nodes and activity even when terminals and descendants are collapsed', () => {
  const terminal = { ...mk('terminal', 'child', 4, { state: 'working' }), kind: 'terminal' as const };
  const blocked = mk('blocked', 'child', 5, { state: 'blocked' });
  update((s) => ({ nodes: { ...s.nodes, terminal, blocked }, order: [...s.order, 'terminal', 'blocked'], collapsed: ['a'] }));
  const sidebar = Sidebar({ onSettings: () => {} });
  const heading = find(sidebar, (el) => el.props.className === 'session-activity');
  const html = renderToStaticMarkup(heading);
  expect(html).toContain('Session activity <span>4</span>');
  expect(html).toContain('3 working');
  expect(html).toContain('1 needs you');
  expect(elements(sidebar).filter((el) => el.type === NodeRow)).toHaveLength(1);
});

it('persists Details visibility, passes selection, and restores the toggle focus on close', () => {
  const setItem = vi.fn();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem });
  expect(readSidebarDetails()).toBe(false);
  vi.stubGlobal('localStorage', { getItem: () => '1', setItem });
  expect(readSidebarDetails()).toBe(true);
  hooks.open = true;
  const sidebar = Sidebar({ onSettings: () => {} });
  const toggle = find(sidebar, (el) => el.props.className === 'btn details-toggle');
  expect(toggle.props['aria-expanded']).toBe(true);
  expect(toggle.props['aria-controls']).toBe('sidebar-inspector');
  const inspector = find(sidebar, (el) => el.type === SidebarInspector);
  expect(inspector.props.node).toBe(child);
  const focus = vi.fn(); toggle.props.ref.current = { focus };
  inspector.props.onClose();
  expect(hooks.setOpen).toHaveBeenLastCalledWith(false);
  expect(setItem).toHaveBeenLastCalledWith('tl.sidebarDetails', '0');
  expect(focus).toHaveBeenCalledOnce();
  toggle.props.onClick();
  expect(setItem).toHaveBeenLastCalledWith('tl.sidebarDetails', '0');
  update(() => ({ historyOpen: true }));
  const history = Sidebar({ onSettings: () => {} });
  expect(elements(history).some((el) => el.type === SidebarInspector || el.props.role === 'tree')).toBe(false);
  expect(readSidebarDetails()).toBe(true);
  vi.stubGlobal('localStorage', { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } });
  expect(readSidebarDetails()).toBe(false);
  expect(() => saveSidebarDetails(true)).not.toThrow();
  vi.unstubAllGlobals();
});

it('opens Details from its default closed state and persists the explicit choice', () => {
  const setItem = vi.fn();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem });
  const sidebar = Sidebar({ onSettings: () => {} });
  expect(elements(sidebar).some((el) => el.type === SidebarInspector)).toBe(false);
  const toggle = find(sidebar, (el) => el.props.className === 'btn details-toggle');
  expect(toggle.props['aria-expanded']).toBe(false);
  toggle.props.onClick();
  expect(hooks.setOpen).toHaveBeenCalledWith(true);
  expect(setItem).toHaveBeenCalledWith('tl.sidebarDetails', '1');
  vi.unstubAllGlobals();
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
