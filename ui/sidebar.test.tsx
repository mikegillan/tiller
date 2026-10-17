import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sidebar } from './Sidebar';
import { NodeRow } from './NodeRow';
import { SessionSwitcher } from './SessionSwitcher';
import { RenameInput } from './RenameInput';
import { getState, setRenaming, update } from './store';
import { send } from './conn';
import { mk } from './fixtures';
import { flattenSession } from './tree';

const hooks = vi.hoisted(() => ({ open: false, setOpen: vi.fn() }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useState: () => [hooks.open, hooks.setOpen], useRef: () => ({ current: null }), useMemo: (fn: () => unknown) => fn(), useEffect: () => {} }));
vi.mock('./store', async (original) => {
  const store = await original<typeof import('./store')>();
  return { ...store, useStore: (select: (state: ReturnType<typeof store.getState>) => unknown) => select(store.getState()) };
});
vi.mock('./conn', () => ({ send: vi.fn() }));
vi.mock('./hooks', () => ({ useNow: () => 10_000 }));
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
  vi.clearAllMocks(); hooks.open = false;
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
  const key = (value: string, tagName = 'DIV') => tree().props.onKeyDown({ key: value, target: { tagName }, preventDefault: vi.fn() });
  key('ArrowLeft'); expect(getState().collapsed).toEqual(['a']);
  key('ArrowRight'); expect(getState().collapsed).toEqual([]);
  key('j'); expect(getState().selected).toBe('child');
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
