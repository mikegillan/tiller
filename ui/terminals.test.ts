import { afterEach, expect, it, vi } from 'vitest';
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { createTerm, disposeTerm } from './terminals';
import { openExternalUrl } from './controls/externalLink';
import { toast } from './store';

const state = vi.hoisted(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn() }));
  return { native: true };
});
vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn(class {
  loadAddon = vi.fn();
  open = vi.fn();
  dispose = vi.fn();
}) }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(class {}) }));
vi.mock('./url', () => ({ get IN_APP() { return state.native; } }));
vi.mock('./controls/externalLink', () => ({ openExternalUrl: vi.fn() }));
vi.mock('./store', () => ({ toast: vi.fn() }));

afterEach(() => {
  disposeTerm('node');
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  state.native = true;
});

function linkHandler() {
  createTerm('node', {} as HTMLElement);
  const options = vi.mocked(Terminal).mock.calls.at(-1)![0] as ITerminalOptions;
  return options.linkHandler!;
}

function activate(url: string) {
  const handler = linkHandler();
  expect(handler.allowNonHttpProtocols).not.toBe(true);
  handler.activate({} as MouseEvent, url, { start: { x: 1, y: 1 }, end: { x: 6, y: 1 } });
}

it('opens terminal Markdown hyperlink targets through the native browser command', () => {
  vi.mocked(openExternalUrl).mockResolvedValue(undefined);
  activate('https://github.com/example/tiller/issues/38072');
  expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith('https://github.com/example/tiller/issues/38072');
});

it('reports native browser failures instead of silently ignoring the click', async () => {
  vi.mocked(openExternalUrl).mockRejectedValue(new Error('No browser'));
  activate('https://example.com');
  await Promise.resolve();
  expect(toast).toHaveBeenCalledExactlyOnceWith('Could not open link: https://example.com', 'node', 'bad');
});

it('opens browser UI links in an isolated new tab', () => {
  state.native = false;
  const open = vi.fn();
  vi.stubGlobal('window', { open });
  activate('http://example.com/path?q=1#note');
  expect(open).toHaveBeenCalledExactlyOnceWith('http://example.com/path?q=1#note', '_blank', 'noopener,noreferrer');
  expect(openExternalUrl).not.toHaveBeenCalled();
});

it.each(['javascript:alert(1)', 'file:///tmp/file', 'mailto:a@example.com', '//example.com'])(
  'does not open unsafe terminal hyperlink targets: %s', (url) => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    activate(url);
    state.native = false;
    activate(url);
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  },
);
