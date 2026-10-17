import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import type { UsageSource } from '../src/shared/protocol';
import { UsagePanel } from './UsagePanel';

const fixture = vi.hoisted(() => ({ now: Date.parse('2026-10-17T12:00:00Z'), state: { usageSources: undefined as UsageSource[] | undefined, usageScanning: false, connected: true, nodes: {} } }));
vi.mock('./store', () => ({ useStore: (select: (state: typeof fixture.state) => unknown) => select(fixture.state) }));
vi.mock('./hooks', () => ({ useNow: () => fixture.now }));
vi.mock('./conn', () => ({ refreshUsage: vi.fn() }));
vi.mock('./Modal', () => ({ Modal: ({ title, children }: { title: string; children: ReactNode }) => <div aria-label={title}>{children}</div> }));
const source = (overrides: Partial<UsageSource> = {}): UsageSource => ({ id: 'discovery:codex', tool: 'codex', scope: 'account', nodeIds: [], installed: true, configured: true, authenticated: null, availability: 'unknown', rateLimits: [], checkedAt: fixture.now, ...overrides });
const report = (overrides: Partial<UsageSource> = {}) => source({ id: 'private-source-id', accountId: 'private-account', pool: 'private-pool', provider: 'private-provider', nodeIds: ['private-node'], at: fixture.now, availability: 'available', rateLimits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-17T14:00:00Z' }, { kind: 'seven_day', percentUsed: 16, resetsAt: '2026-10-20T12:00:00Z' }], ...overrides });
const render = () => renderToStaticMarkup(<UsagePanel onClose={() => {}} />);
beforeEach(() => { fixture.state = { usageSources: [], usageScanning: false, connected: true, nodes: {} }; });

it('shows only installed tools, every window, percentages, resets and decorative real logos', () => {
  fixture.state.usageSources = [source(), report(), source({ id: 'discovery:claude', tool: 'claude' }), source({ id: 'discovery:pi', tool: 'pi', installed: false })];
  const html = render();
  expect(html).toContain('Account limits for installed CLIs');
  expect(html).toContain('42% used'); expect(html).toContain('16% used');
  expect(html).toContain('5-hour limit'); expect(html).toContain('Weekly limit'); expect(html).toContain('Resets');
  expect(html.match(/<progress /g)).toHaveLength(2);
  expect(html).toContain('Open Claude Code to load usage.'); expect(html).not.toContain('>Pi<');
  expect(html).toContain('alt=""'); expect(html).toContain('usage-openai-logo'); expect(html).toContain('claude.png');
  for (const secret of ['private-source', 'private-account', 'private-pool', 'private-provider', 'private-node', 'PATH', 'authenticated']) expect(html).not.toContain(secret);
});

it('keeps separate accounts and model quotas separate without losing any valid windows', () => {
  fixture.state.usageSources = [source(), report(), report({ id: 'another', accountId: 'another-account', scope: 'model', model: 'sonnet', rateLimits: [{ kind: 'seven_day_sonnet', percentUsed: 80 }] })];
  const html = render();
  expect(html).toContain('Separate quota 1'); expect(html).toContain('Separate quota 2'); expect(html).toContain('sonnet');
  expect(html.match(/<progress /g)).toHaveLength(3); expect(html).toContain('Weekly Sonnet limit'); expect(html).toContain('Reset time unavailable');
});

it('retains overflow usage honestly while capping the bar and withholds expired readings', () => {
  fixture.state.usageSources = [report({ rateLimits: [{ kind: 'five_hour', percentUsed: 125 }, { kind: 'seven_day', percentUsed: 99, resetsAt: '2026-10-17T11:00:00Z' }] })];
  const html = render();
  expect(html).toContain('125% used'); expect(html).toContain('value="100"'); expect(html).not.toContain('99% used');
  expect(html).toContain('Reset passed · awaiting update'); expect(html).toContain('may be out of date');
});

it('shows honest loading, empty, broken, unavailable and disconnected states', () => {
  fixture.state.usageSources = undefined; expect(render()).toContain('Waiting for CLI usage');
  fixture.state.usageSources = []; expect(render()).toContain('No supported CLIs detected');
  fixture.state.usageSources = [source({ executableStatus: 'broken' })]; expect(render()).toContain('Unable to run Codex');
  fixture.state.usageSources = [source(), report({ availability: 'unavailable' }), source({ id: 'unavailable:codex:n1', nodeIds: ['private-node'], availability: 'unavailable' })]; expect(render()).toContain('Usage unavailable');
  fixture.state.connected = false; expect(render()).toContain('Disconnected');
  fixture.state.usageScanning = true; expect(render()).toContain('Refreshing…');
});


it('honors current installation discovery over retained reports and does not borrow another account failure', () => {
  fixture.state.usageSources = [source({ installed: false }), report()]; expect(render()).not.toContain('42% used');
  fixture.state.usageSources = [source(), report(), source({ id: 'unavailable:codex:other', nodeIds: ['other'], availability: 'unavailable' })];
  expect(render()).not.toContain('Usage unavailable');
});


it('reports unavailable usage when a running CLI cannot supply any limits', () => {
  fixture.state.usageSources = [source(), source({ id: 'unavailable:codex:running-node', installed: null, nodeIds: ['running-node'], availability: 'unavailable' })];
  const html = render();
  expect(html).toContain('Usage unavailable');
  expect(html).not.toContain('Open Codex to load usage.');
});

it('reports unavailable usage after the final quota window is removed', () => {
  fixture.state.usageSources = [source(), report({ rateLimits: [], availability: 'unavailable' })];
  const html = render();
  expect(html).toContain('Usage unavailable');
  expect(html).not.toContain('Open Codex to load usage.');
  expect(html).not.toContain('<progress');
});

it('keeps healthy shared-account usage available when another reporter fails', () => {
  fixture.state.usageSources = [source(), report({ nodeIds: ['healthy', 'failed'] }), source({ id: 'unavailable:codex:failed', installed: null, nodeIds: ['failed'], availability: 'unavailable' })];
  const html = render();
  expect(html).toContain('42% used');
  expect(html).not.toContain('Usage unavailable');
});
