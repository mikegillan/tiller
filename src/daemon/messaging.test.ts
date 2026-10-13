import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeStatus, NodeView } from '../shared/protocol.js';
import { classify, composerTextOf } from './pty.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ack, deliver, flushInbox, inbox, messageStatus, startNotices, type Mgr } from './messaging.js';

const PROMPT = ['some output', '────────────────── n-b', '❯ ', '──────────────────'];

class FakeSession {
  pasted: string[] = [];
  ack = true;
  constructor(private mgr: FakeManager, private id: string, public lines = PROMPT) {}
  async flush() {}
  classifyScreen() { return classify(this.lines); }
  composerText() { return composerTextOf(this.lines); }
  async paste(text: string) {
    this.pasted.push(text);
    if (this.ack) {
      this.mgr.emit('hook', this.id, { hook_event_name: 'UserPromptSubmit', prompt: `[Pasted text] ${text}` });
      this.mgr.set(this.id, { state: 'working', doneSource: undefined });
    }
  }
}

class FakeManager extends EventEmitter {
  nodes = new Map<string, NodeView>();
  sessions = new Map<string, FakeSession>();
  view = (id: string) => this.nodes.get(id);
  session = (id: string) => this.sessions.get(id) as never;
  add(id: string, parentId: string | null, status: Partial<NodeStatus> = {}, kind: 'claude' | 'terminal' = 'claude') {
    this.nodes.set(id, { id, parentId, kind, title: `T-${id}`, cwd: '/', createdAt: 0, unread: false, status: { state: 'done', doneSource: 'stop', changedAt: 0, ...status } });
    this.sessions.set(id, new FakeSession(this, id));
  }
  set(id: string, patch: Partial<NodeStatus>) {
    const v = this.nodes.get(id)!;
    v.status = { ...v.status, ...patch };
    this.emit('node', v);
  }
  get mgr() { return this as unknown as Mgr; }
}

let m: FakeManager;
beforeEach(() => {
  vi.useFakeTimers();
  m = new FakeManager();
  m.add('p', null);          // parent
  m.add('a', 'p');           // child a
  m.add('b', 'p');           // child b (sibling of a)
  m.add('x', null);          // unrelated root
  m.add('t', 'p', { state: 'none' }, 'terminal');
});
afterEach(() => vi.useRealTimers());

describe('gates', () => {
  it('delivers to a verified-idle sibling and reports the receipt', async () => {
    const r = await deliver(m.mgr, 'a', 'b', 'hello');
    expect(r).toMatchObject({ outcome: 'delivered', retryable: false });
    expect(r.messageId).toMatch(/^m-/);
  });

  it('refuses out-of-lineage, self and terminal targets; reports gone for missing or exited', async () => {
    expect(await deliver(m.mgr, 'a', 'x', 'hi')).toMatchObject({ outcome: 'refused' });
    expect(await deliver(m.mgr, 'a', 'a', 'hi')).toMatchObject({ outcome: 'refused' });
    expect(await deliver(m.mgr, 'a', 't', 'hi')).toMatchObject({ outcome: 'refused', detail: expect.stringContaining('not an agent node') });
    expect(await deliver(m.mgr, 'human', 'nope', 'hi')).toMatchObject({ outcome: 'gone' });
    expect(await deliver(m.mgr, 'a', 'nope', 'hi')).toMatchObject({ outcome: 'refused' }); // no existence probe
    m.set('b', { exited: true });
    expect(await deliver(m.mgr, 'a', 'b', 'hi')).toMatchObject({ outcome: 'gone' });
  });

  it('allows ancestor and descendant but not cousins', async () => {
    m.add('g', 'a'); // grandchild
    expect((await deliver(m.mgr, 'g', 'p', 'up')).outcome).toBe('delivered');
    expect((await deliver(m.mgr, 'p', 'g', 'down')).outcome).toBe('delivered');
    expect((await deliver(m.mgr, 'g', 'b', 'cousin-ish')).outcome).toBe('refused'); // g's uncle is not in lineage
  });

  it.each([
    ['working', { state: 'working' as const }],
    ['done via idle_prompt', { doneSource: 'idle_prompt' as const }],
    ['done via sweep', { doneSource: 'sweep' as const, stale: true }],
    ['stale', { stale: true }],
    ['blocked', { state: 'blocked' as const }],
  ])('queues when the target is %s', async (_n, patch) => {
    m.set('b', patch);
    const r = await deliver(m.mgr, 'a', 'b', 'hi');
    expect(r.outcome).toBe('queued');
    expect(m.sessions.get('b')!.pasted).toHaveLength(0);
  });

  it('queues when a dialog is showing or the composer holds a draft', async () => {
    m.sessions.get('b')!.lines = ['Do you trust this folder?', '❯ 1. Yes', '  2. No, exit', 'Enter to confirm · Esc to cancel'];
    expect(await deliver(m.mgr, 'a', 'b', 'hi')).toMatchObject({ outcome: 'queued', detail: expect.stringContaining('dialog') });
    m.sessions.get('p')!.lines = ['────── p', '❯ half typed', '──────'];
    expect(await deliver(m.mgr, 'a', 'p', 'hi')).toMatchObject({ outcome: 'queued', detail: expect.stringContaining('unsent') });
    expect(m.sessions.get('p')!.pasted).toHaveLength(0);
  });

  it('rate limits one send per pair per 10 s', async () => {
    await deliver(m.mgr, 'a', 'b', 'one');
    const r = await deliver(m.mgr, 'a', 'b', 'two');
    expect(r).toMatchObject({ outcome: 'refused', retryable: true, detail: 'rate limited, retry in 10 s' });
    expect((await deliver(m.mgr, 'b', 'a', 'other direction')).outcome).toBe('delivered');
    await vi.advanceTimersByTimeAsync(10_000);
    m.set('b', { state: 'done', doneSource: 'stop' });
    expect((await deliver(m.mgr, 'a', 'b', 'three')).outcome).toBe('delivered');
  });

  it('reports stalled when no matching UserPromptSubmit arrives within 8 s', async () => {
    m.sessions.get('b')!.ack = false;
    const p = deliver(m.mgr, 'a', 'b', 'hi');
    await vi.advanceTimersByTimeAsync(8000);
    expect(await p).toMatchObject({ outcome: 'stalled', retryable: false });
  });
});

describe('envelope', () => {
  it('frames the message with a per-delivery nonce', async () => {
    await deliver(m.mgr, 'a', 'b', 'line1\nline2');
    m.set('b', { state: 'done', doneSource: 'stop' });
    await deliver(m.mgr, 'p', 'b', 'again');
    const [first, second] = m.sessions.get('b')!.pasted;
    const nonceOf = (t: string) => /^--- O8 MESSAGE (\S+) ---\n/.exec(t)?.[1];
    expect(nonceOf(first)).toBeTruthy();
    expect(nonceOf(second)).toBeTruthy();
    expect(nonceOf(first)).not.toBe(nonceOf(second));
    expect(first).toBe(`--- O8 MESSAGE ${nonceOf(first)} ---\nfrom: T-a (a)\nreply-to: a\nline1\nline2\n--- END O8 MESSAGE ${nonceOf(first)} ---`);
  });
});

describe('queue', () => {
  it('caps at 16, then refuses with queueFull', async () => {
    m.set('b', { state: 'working' });
    for (let i = 0; i < 16; i++) expect((await deliver(m.mgr, 'orchestr8', 'b', `m${i}`)).outcome).toBe('queued');
    expect(await deliver(m.mgr, 'orchestr8', 'b', 'overflow')).toMatchObject({ outcome: 'queueFull', retryable: true });
  });

  it('expires after 5 minutes and tells the sender through message_status', async () => {
    m.set('b', { state: 'working' });
    const r = await deliver(m.mgr, 'a', 'b', 'hi');
    expect(messageStatus(m.mgr, 'a', r.messageId!)?.outcome).toBe('queued');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(messageStatus(m.mgr, 'a', r.messageId!)).toMatchObject({ outcome: 'expired', retryable: true });
    expect(messageStatus(m.mgr, 'p', r.messageId!)).toBeUndefined(); // only the sender may ask
  });

  it('flushes in order when the target reaches verified idle, one at a time', async () => {
    m.set('b', { state: 'working' });
    const r1 = await deliver(m.mgr, 'orchestr8', 'b', 'first');
    const r2 = await deliver(m.mgr, 'orchestr8', 'b', 'second');
    m.set('b', { state: 'done', doneSource: 'stop' });
    await vi.advanceTimersByTimeAsync(0);
    const pasted = m.sessions.get('b')!.pasted;
    expect(pasted).toHaveLength(1);
    expect(pasted[0]).toContain('first');
    expect(messageStatus(m.mgr, 'orchestr8', r1.messageId!)?.outcome).toBe('delivered');
    expect(messageStatus(m.mgr, 'orchestr8', r2.messageId!)?.outcome).toBe('queued');
    m.set('b', { state: 'working' });
    m.set('b', { state: 'done', doneSource: 'stop' });
    await vi.advanceTimersByTimeAsync(0);
    expect(m.sessions.get('b')!.pasted[1]).toContain('second');
  });

  it('retries every second while the target is verified idle but its composer has not repainted', async () => {
    m.set('b', { state: 'working' });
    const r = await deliver(m.mgr, 'a', 'b', 'hi');
    const b = m.sessions.get('b')!;
    b.lines = ['still repainting'];
    m.set('b', { state: 'done', doneSource: 'stop' }); // Stop arrives first; the screen check fails
    await vi.advanceTimersByTimeAsync(0);
    expect(b.pasted).toHaveLength(0);
    b.lines = PROMPT; // composer repaints; no further node event follows
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.pasted).toHaveLength(1);
    expect(messageStatus(m.mgr, 'a', r.messageId!)?.outcome).toBe('delivered');
  });

  it('records immediate outcomes for message_status too', async () => {
    const r = await deliver(m.mgr, 'a', 'b', 'hi');
    expect(r.outcome).toBe('delivered');
    expect(messageStatus(m.mgr, 'a', r.messageId!)).toMatchObject({ outcome: 'delivered' });
    await vi.advanceTimersByTimeAsync(3600_000 + 1);
    await deliver(m.mgr, 'p', 'x', 'prune trigger');
    expect(messageStatus(m.mgr, 'a', r.messageId!)).toBeUndefined();
  });

  it('resolves queued messages as gone when the target exits', async () => {
    m.set('b', { state: 'working' });
    const r = await deliver(m.mgr, 'a', 'b', 'hi');
    m.set('b', { exited: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(messageStatus(m.mgr, 'a', r.messageId!)?.outcome).toBe('gone');
  });
});

describe('mod inbox', () => {
  beforeEach(() => { inbox(m.mgr, 'b'); }); // b's mod polls

  it('queues for a mod-live target without pasting; the inbox lists it; ack resolves it as delivered', async () => {
    m.set('b', { state: 'working' });
    const r = await deliver(m.mgr, 'a', 'b', 'hello');
    expect(r).toMatchObject({ outcome: 'queued', retryable: false, messageId: expect.stringMatching(/^m-/) });
    const [msg] = inbox(m.mgr, 'b');
    expect(msg).toMatchObject({ id: r.messageId, from: 'T-a (a)' });
    expect(msg.text).toMatch(/^--- O8 MESSAGE (\S+) ---\nfrom: T-a \(a\)\nreply-to: a\nhello\n--- END O8 MESSAGE \1 ---$/);
    expect(m.sessions.get('b')!.pasted).toHaveLength(0);
    expect(messageStatus(m.mgr, 'a', r.messageId!)?.outcome).toBe('queued');
    expect(ack(m.mgr, 'p', r.messageId!)).toBe(false); // not p's message
    expect(ack(m.mgr, 'b', r.messageId!)).toBe(true);
    expect(inbox(m.mgr, 'b')).toEqual([]);
    expect(messageStatus(m.mgr, 'a', r.messageId!)).toMatchObject({ outcome: 'delivered' });
  });

  it('expires unacked messages after 5 minutes and removes them from the inbox', async () => {
    const r = await deliver(m.mgr, 'a', 'b', 'hi');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(inbox(m.mgr, 'b')).toEqual([]);
    expect(messageStatus(m.mgr, 'a', r.messageId!)).toMatchObject({ outcome: 'expired', retryable: true });
  });

  it('caps the inbox at 16', async () => {
    for (let i = 0; i < 16; i++) expect((await deliver(m.mgr, 'orchestr8', 'b', `m${i}`)).outcome).toBe('queued');
    expect(await deliver(m.mgr, 'orchestr8', 'b', 'overflow')).toMatchObject({ outcome: 'queueFull', retryable: true });
  });

  it('station notices ride the inbox too', async () => {
    startNotices(m.mgr);
    inbox(m.mgr, 'p');
    m.set('a', { state: 'done', errored: true, doneSource: 'stop' });
    await vi.advanceTimersByTimeAsync(0);
    expect(inbox(m.mgr, 'p')[0].text).toContain('stopped: turn-errored');
    expect(m.sessions.get('p')!.pasted).toHaveLength(0);
  });

  it('falls back to paste once the mod has not polled for 5 s', async () => {
    await vi.advanceTimersByTimeAsync(5000);
    expect((await deliver(m.mgr, 'a', 'b', 'still live')).outcome).toBe('queued'); // exactly 5 s: still live
    await vi.advanceTimersByTimeAsync(1);
    const r = await deliver(m.mgr, 'p', 'b', 'stale mod');
    expect(r.outcome).toBe('delivered');
    expect(m.sessions.get('b')!.pasted).toHaveLength(1);
  });

  it('survives a restart; entries past their TTL are dropped', async () => {
    const home = mkdtempSync(join(tmpdir(), 'o8inbox-'));
    try {
      const withHome = (): Mgr => Object.assign(Object.create(m), { home }) as Mgr; // fresh state per Mgr object
      const m1 = withHome();
      inbox(m1, 'b');
      const keep = await deliver(m1, 'a', 'b', 'keep');
      await vi.advanceTimersByTimeAsync(60);
      expect(JSON.parse(readFileSync(join(home, 'inbox.json'), 'utf8')).items).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      const m2 = withHome();
      expect(inbox(m2, 'b').map((x) => x.id)).toEqual([keep.messageId]);
      await vi.advanceTimersByTimeAsync(60_000 + 1);
      expect(inbox(m2, 'b')).toEqual([]);
      expect(inbox(withHome(), 'b')).toEqual([]); // expired entry is not reloaded
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('flushInbox writes a pending save at once, so a shutdown inside the debounce loses nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'o8inbox-'));
    try {
      const m1 = Object.assign(Object.create(m.mgr), { home }) as Mgr;
      inbox(m1, 'b');
      const sent = await deliver(m1, 'a', 'b', 'just before shutdown');
      flushInbox(m1); // no timers advanced: the 50 ms debounce has not fired
      expect(JSON.parse(readFileSync(join(home, 'inbox.json'), 'utf8')).items.map((i: { msg: { id: string } }) => i.msg.id)).toEqual([sent.messageId]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('station notices', () => {
  it('notifies the parent once per episode and re-arms after a clean turn', async () => {
    startNotices(m.mgr);
    const pasted = () => m.sessions.get('p')!.pasted;
    m.set('a', { state: 'done', errored: true, doneSource: 'stop' });
    await vi.advanceTimersByTimeAsync(0);
    expect(pasted()).toHaveLength(1);
    expect(pasted()[0]).toMatch(/\nfrom: orchestr8 \(child a "T-a" stopped: turn-errored\)\nreply-to: none\n/);
    m.set('a', { unread: true } as never); // other node events do not re-notify
    m.set('a', { state: 'done', errored: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(pasted()).toHaveLength(1);
    m.set('p', { state: 'done', doneSource: 'stop' }); // parent finished handling the first notice
    m.set('a', { state: 'working', errored: undefined });
    m.set('a', { state: 'done', errored: undefined, doneSource: 'idle_prompt' }); // not a verified Stop: no re-arm
    m.set('a', { state: 'done', errored: true, doneSource: 'stop' });
    await vi.advanceTimersByTimeAsync(0);
    expect(pasted()).toHaveLength(1);
    m.set('a', { state: 'done', errored: undefined, doneSource: 'stop' }); // clean Stop re-arms
    m.set('a', { state: 'done', errored: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(pasted()).toHaveLength(2);
  });

  it('notifies on exit, and after 15 minutes of waiting; never for blocked', async () => {
    startNotices(m.mgr);
    m.set('a', { state: 'blocked' });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(m.sessions.get('p')!.pasted).toHaveLength(0);
    m.set('b', { state: 'waiting' });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(m.sessions.get('p')!.pasted[0]).toContain('stopped: question-unanswered');
    m.set('p', { state: 'done', doneSource: 'stop' });
    m.set('a', { exited: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(m.sessions.get('p')!.pasted[1]).toContain('child a "T-a" stopped: exited');
  });
});
