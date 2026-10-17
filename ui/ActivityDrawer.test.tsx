import { afterEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityDrawer } from './ActivityDrawer';
import { setActivityOpen } from './store';

// Render the actual surfaces with a fixed state snapshot; subscriptions need a browser.
vi.mock('./store', async (importOriginal) => {
  const store = await importOriginal<typeof import('./store')>();
  return { ...store, useStore: (select: (state: ReturnType<typeof store.getState>) => unknown) => select(store.getState()) };
});

afterEach(() => { setActivityOpen(false); vi.unstubAllGlobals(); });

it.each([true, false])('uses a native modal surface only when the drawer covers the viewport: narrow=%s', (narrow) => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: narrow }) });
  vi.stubGlobal('document', { activeElement: null });
  setActivityOpen(true);
  const html = renderToStaticMarkup(<ActivityDrawer />);
  expect(html.startsWith(narrow ? '<dialog' : '<aside')).toBe(true);
  expect(html).toContain('aria-labelledby="activity-heading"');
  expect(html).toContain('No activity yet');
  expect(html).not.toContain(narrow ? '<aside' : '<dialog');
});
