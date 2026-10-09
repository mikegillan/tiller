import { describe, expect, it } from 'vitest';
import type { NodeStatus, NodeView } from '../shared/protocol.js';
import { content, createNotifier, notifyArgs, type NotifierDeps } from './notifier.js';

const node = (title: string, status: Partial<NodeStatus> = {}): NodeView => ({
  id: 'n1', parentId: null, kind: 'claude', title, cwd: '/', createdAt: 0, unread: false,
  status: { state: 'done', changedAt: 0, ...status },
});

describe('content', () => {
  it('blocked: needs approval with the tool', () => {
    const n = node('api', { state: 'blocked', activity: 'needs approval: Bash touch /tmp/x' });
    expect(content(n, 'needsYou')).toEqual({ title: 'api', subtitle: undefined, body: 'Needs approval: Bash touch /tmp/x', sound: true });
  });

  it('waiting: the question, else the first line of the last message', () => {
    expect(content(node('a', { state: 'waiting', activity: 'question: Which db?' }), 'needsYou').body).toBe('Asks: Which db?');
    expect(content(node('a', { state: 'waiting', lastAssistantMessage: '\nShall I proceed?\nmore' }), 'needsYou').body).toBe('Asks: Shall I proceed?');
  });

  it('done and errored use the first line, 120 chars, and only errors make a sound', () => {
    const msg = 'x'.repeat(200) + '\nsecond';
    const done = content(node('a', { lastAssistantMessage: msg }), 'done');
    expect(done.body).toBe(`Finished: ${'x'.repeat(120)}`);
    expect(done.sound).toBe(false);
    const bad = content(node('a', { errored: true, lastAssistantMessage: 'rate limited' }), 'errored');
    expect(bad).toMatchObject({ body: 'Turn failed: rate limited', sound: true });
  });

  it('exited, and the session title as subtitle only when it differs', () => {
    expect(content(node('child'), 'exited', 'session')).toEqual({ title: 'child', subtitle: 'session', body: 'Exited', sound: false });
    expect(content(node('same'), 'exited', 'same').subtitle).toBeUndefined();
  });
});

describe('notifyArgs', () => {
  const c = { title: 'api', subtitle: 'sess', body: 'Needs approval: Bash ls', sound: true };
  const base = { terminalNotifier: '/bin/tn', terminalBundle: 'com.mitchellh.ghostty', appConnected: () => false, onClick: (id: string) => `o8 select ${id}` };

  it('builds terminal-notifier args, activating the app when connected, else the terminal', () => {
    expect(notifyArgs(c, 'n1', base).args).toEqual([
      '-title', 'api', '-subtitle', 'sess', '-message', 'Needs approval: Bash ls', '-group', 'n1',
      '-sound', 'default', '-activate', 'com.mitchellh.ghostty', '-execute', 'o8 select n1',
    ]);
    expect(notifyArgs(c, 'n1', { ...base, appConnected: () => true }).args).toContain('dev.orchestr8.app');
  });

  it('falls back to osascript without terminal-notifier, escaping quotes', () => {
    const r = notifyArgs({ ...c, body: 'say "hi"', subtitle: undefined }, 'n1', { ...base, terminalNotifier: undefined });
    expect(r).toEqual({ file: 'osascript', args: ['-e', 'display notification "say \\"hi\\"" with title "api"'] });
  });
});

describe('createNotifier', () => {
  const setup = (watchers = 0) => {
    const calls: string[][] = [];
    let t = 1000, w = watchers;
    const notify = createNotifier({
      view: () => node('api', { state: 'blocked', activity: 'needs approval: Bash ls' }), rootTitle: () => 'api',
      watchers: () => w, appConnected: () => false, terminalNotifier: '/bin/tn', onClick: (id) => id,
      run: (_f, a) => calls.push(a), now: () => t,
    } satisfies NotifierDeps);
    return { calls, notify, tick: (ms: number) => { t += ms; }, watch: (n: number) => { w = n; } };
  };
  const ev = (kind: 'needsYou' | 'done') => ({ id: 'n1', kind, title: 'api' }) as const;

  it('is silent while a focused client has the node selected, and does not spend the throttle', () => {
    const s = setup(1);
    s.notify(ev('needsYou'));
    expect(s.calls).toHaveLength(0);
    s.watch(0);
    s.notify(ev('needsYou'));
    expect(s.calls).toHaveLength(1);
  });

  it('throttles per node and kind for 5 s', () => {
    const s = setup();
    s.notify(ev('needsYou'));
    s.tick(4000); s.notify(ev('needsYou'));
    s.notify(ev('done'));
    expect(s.calls).toHaveLength(2);
    s.tick(1000); s.notify(ev('needsYou'));
    expect(s.calls).toHaveLength(3);
  });
});
