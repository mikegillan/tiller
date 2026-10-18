import { afterEach, expect, it, vi } from 'vitest';
import { Markdown } from './Markdown';
import { openExternalUrl } from './externalLink';

const state = vi.hoisted(() => ({ native: true, failed: false, setError: vi.fn() }));
vi.mock('./url', () => ({ get IN_APP() { return state.native; } }));
vi.mock('./externalLink', () => ({ openExternalUrl: vi.fn() }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useState: () => [state.failed, state.setError] }));
afterEach(() => { vi.clearAllMocks(); state.native = true; state.failed = false; });

it('intercepts native web links and exposes failures without navigating away from Tiller', async () => {
  vi.mocked(openExternalUrl).mockRejectedValue(new Error('No browser'));
  const view = Markdown({ children: '[Link](https://example.com)' });
  const anchor = view.props.children[0].props.components.a({ href: 'https://example.com', children: 'Link' });
  const event = { preventDefault: vi.fn() };
  await anchor.props.onClick(event);
  await Promise.resolve();
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith('https://example.com');
  expect(state.setError).toHaveBeenLastCalledWith(true);
  state.failed = true;
  const error = Markdown({ children: '' }).props.children[1];
  expect(error.props.role).toBe('alert');
  expect(error.props.children).toContain('copy the link address');
});

it('retains ordinary browser anchors and local footnote navigation', () => {
  state.native = false;
  let renderer = Markdown({ children: '' }).props.children[0].props.components.a;
  expect(renderer({ href: 'https://example.com' }).props.onClick).toBeUndefined();
  state.native = true;
  renderer = Markdown({ children: '' }).props.children[0].props.components.a;
  expect(renderer({ href: '#note' }).props.onClick).toBeUndefined();
  expect(openExternalUrl).not.toHaveBeenCalled();
});
