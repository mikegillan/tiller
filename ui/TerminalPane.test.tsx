import { afterEach, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { TerminalPane } from './TerminalPane';
import { send } from './conn';
import { disposeTerm } from './terminals';

const fixture = vi.hoisted(() => ({
  effects: [] as (() => (() => void) | void)[],
  onData: vi.fn(),
  onBinary: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useEffect: (fn: () => (() => void) | void) => fixture.effects.push(fn),
  useRef: () => ({ current: {} }),
}));
vi.mock('./store', () => ({ useStore: (select: (s: unknown) => unknown) => select({
  opened: ['codex'], selected: 'codex', nodes: {}, connected: false,
}) }));
vi.mock('./conn', () => ({ send: vi.fn() }));
vi.mock('./terminals', () => ({
  createTerm: () => ({ term: { onData: fixture.onData, onBinary: fixture.onBinary } }),
  disposeTerm: vi.fn(), getTerm: vi.fn(),
}));

afterEach(() => { fixture.effects.length = 0; vi.clearAllMocks(); });

it('forwards text and legacy wheel reports separately and disposes both input subscriptions', () => {
  const textSubscription = { dispose: vi.fn() };
  const binarySubscription = { dispose: vi.fn() };
  fixture.onData.mockReturnValue(textSubscription);
  fixture.onBinary.mockReturnValue(binarySubscription);
  const pane = TerminalPane();
  const view = pane.props.children[0] as ReactElement<{ id: string; visible: boolean; exited: boolean }>;
  (view.type as (props: typeof view.props) => ReactElement)(view.props);
  const cleanup = fixture.effects[0]();

  expect(fixture.onBinary).toHaveBeenCalledOnce();
  fixture.onData.mock.calls[0][0]('hello 🌍');
  // X10 wheel up at column 100, row 3: the coordinate is a raw 0x84 byte.
  fixture.onBinary.mock.calls[0][0]('\x1b[M`\x84#');
  expect(send).toHaveBeenNthCalledWith(1, { t: 'input', id: 'codex', data: 'hello 🌍' });
  expect(send).toHaveBeenNthCalledWith(2, { t: 'input', id: 'codex', data: '\x1b[M`\x84#', binary: true });

  cleanup!();
  expect(textSubscription.dispose).toHaveBeenCalledOnce();
  expect(binarySubscription.dispose).toHaveBeenCalledOnce();
  expect(disposeTerm).toHaveBeenCalledExactlyOnceWith('codex');
});
