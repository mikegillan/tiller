import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Dialogs } from './Dialogs';
import { getState, update } from './store';

vi.mock('./Modal', () => ({ Modal: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) => <>{children}{footer}</> }));
vi.mock('./conn', () => ({ send: vi.fn() }));
vi.mock('./store', async (original) => {
  const store = await original<typeof import('./store')>();
  return { ...store, useStore: (select: (state: ReturnType<typeof store.getState>) => unknown) => select(store.getState()) };
});
const release = { id: 1, tag: 'v1.2.3', name: 'v1.2.3', sha: 'new', tagObject: 'tag', publishedAt: '', body: '## Improvements\n\n- **Readable** notes\n\nhttps://github.com/example/tiller' };
beforeEach(() => {
  vi.stubGlobal('document', { activeElement: null });
  update(() => ({ dialog: null, update: undefined }));
});

it.each(['update', 'whatsNew'] as const)('renders Markdown in the %s release notes while retaining the source', (kind) => {
  const notes = { identity: 'installed', releases: [release] };
  update(() => ({ update: { sha: 'old', checkedAt: 1, eligible: false, releases: [release], target: release }, dialog: kind === 'update' ? { kind } : { kind, notes } }));
  const html = renderToStaticMarkup(<Dialogs />);
  expect(html).toContain('<h2>Improvements</h2>');
  expect(html).toContain('<li><strong>Readable</strong> notes</li>');
  expect(html).toContain('href="https://github.com/example/tiller"');
  expect(html).toContain('>Close</button>');
  if (kind === 'update') expect(html).toContain('>Check releases</button>');
  expect(getState().update?.releases[0].body).toBe(release.body);
});

it.each(['update', 'whatsNew'] as const)('keeps the empty-note fallback in %s', (kind) => {
  const empty = { ...release, body: '' };
  update(() => ({ update: { sha: 'old', checkedAt: 1, eligible: false, releases: [], target: empty }, dialog: kind === 'update' ? { kind } : { kind, notes: { identity: 'empty', releases: [empty] } } }));
  expect(renderToStaticMarkup(<Dialogs />)).toContain('<p>No release notes provided.</p>');
});
