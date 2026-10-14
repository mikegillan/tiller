import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { notifyWhen, watching } from './deps.js';
import { NodeManager } from './manager.js';
import { inbox } from './messaging.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('dependency launches, notify_when and the spawn queue (fake claude)', () => {
  let home = '';
  const managers: NodeManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.shutdown())); // before the home goes, so no append fails after the file's tests end
    rmSync(home, { recursive: true, force: true });
  });

  async function setup(config?: object) {
    home = mkdtempSync(join(tmpdir(), 'tl-deps-'));
    const bin = join(home, 'bin'), proj = join(home, 'proj');
    mkdirSync(bin);
    mkdirSync(proj);
    mkdirSync(join(home, 'tl'));
    if (config) writeFileSync(join(home, 'tl', 'config.json'), JSON.stringify(config));
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nsleep 30\n');
    chmodSync(join(bin, 'claude'), 0o755);
    const open = () => {
      const m = new NodeManager({ home: join(home, 'tl'), shell: '/bin/sh', path: `${bin}:/usr/bin:/bin` });
      managers.push(m);
      return m;
    };
    const m = open();
    const root = (await m.spawn({ kind: 'claude', title: 'root', cwd: proj, byHuman: true })).id;
    const child = async (title: string, extra = {}) => (await m.spawn({ kind: 'claude', title, cwd: proj, parentId: root, prompt: 'go', ...extra })).id;
    const turn = (id: string, end = true) => {
      m.applyHook(id, { hook_event_name: 'UserPromptSubmit' });
      if (end) m.applyHook(id, { hook_event_name: 'Stop' });
    };
    const outcome = (id: string, outcome: 'succeeded' | 'failed', note?: string) => m.setOutcome(id, { outcome, note, at: Date.now() });
    const live = (id: string) => !!m.session(id);
    return { m, open, root, child, turn, outcome, live, proj };
  }

  it('launches an after node when its dependency ends a turn begun after the spawn, and not before', async () => {
    const { m, child, turn, live } = await setup();
    const a = await child('a');
    m.applyHook(a, { hook_event_name: 'UserPromptSubmit' }); // a turn already running when b is armed does not count
    await tick();
    const b = await child('b', { after: [a] });
    expect(m.view(b)!.status).toMatchObject({ state: 'armed', activity: `after ${a}` });
    m.applyHook(a, { hook_event_name: 'Stop' });
    await tick();
    expect(live(b)).toBe(false);
    turn(a);
    await expect.poll(() => live(b)).toBe(true);
    expect(m.view(b)!.status.state).toBe('unknown');
    expect(m.registry.get(b)!.pending).toBeUndefined();
  });

  it('afterSuccess waits for the outcome, and a failed one blocks with a notice to the parent', async () => {
    const { m, root, child, turn, outcome, live } = await setup();
    inbox(m, root); // the root's mod is polling, so notices land in its inbox
    const a = await child('a'), c = await child('c');
    const b = await child('b', { afterSuccess: [a] }), d = await child('d', { afterSuccess: [c] });
    turn(a);
    await tick();
    expect(live(b)).toBe(false);
    outcome(a, 'succeeded');
    await expect.poll(() => live(b)).toBe(true);

    outcome(c, 'failed', 'tests broke');
    await expect.poll(() => m.view(d)!.status.activity).toBe(`blocked by ${c}: failed: tests broke`);
    expect(live(d)).toBe(false);
    const notices = inbox(m, root).filter((x) => x.text.includes(`armed ${d} blocked`));
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain(`blocked by ${c}: failed: tests broke`);
  });

  it('refuses unknown dependencies and ones outside the caller\'s scope', async () => {
    const { m, child, proj } = await setup();
    await expect(child('x', { after: ['n-00000000'] })).rejects.toThrow(/no such node n-00000000/);
    const other = (await m.spawn({ kind: 'claude', title: 'other root', cwd: proj, byHuman: true })).id;
    await expect(child('y', { afterSuccess: [other] })).rejects.toThrow(/outside your lineage/);
    expect(m.list().map((v) => v.title)).not.toContain('y');
  });

  it('notify_when all sends one message with every outcome', async () => {
    const { m, root, child, outcome } = await setup();
    inbox(m, root);
    const a = await child('a'), b = await child('b');
    expect(notifyWhen(m, root, { ids: [a, b], when: 'all', of: 'success' })).toEqual({ replaced: false });
    expect(notifyWhen(m, root, { ids: [b, a], when: 'all', of: 'success' })).toEqual({ replaced: true });
    outcome(a, 'succeeded', 'did a');
    await tick();
    expect(inbox(m, root)).toHaveLength(0);
    outcome(b, 'failed', 'b broke');
    await expect.poll(() => inbox(m, root).length).toBe(1);
    const text = inbox(m, root)[0].text;
    expect(text).toContain('2 of 2 finished');
    expect(text).toContain(`${a}: succeeded: did a`);
    expect(text).toContain(`${b}: failed: b broke`);
    outcome(a, 'succeeded', 'again');
    await tick();
    expect(inbox(m, root)).toHaveLength(1); // one-shot
  });

  it('drops a notify_when when its caller is closed', async () => {
    const { m, child } = await setup();
    const a = await child('a'), b = await child('b');
    notifyWhen(m, a, { ids: [b], when: 'all', of: 'success' });
    expect(watching(m, a, b)).toBe(true);
    await m.close(a);
    expect(watching(m, a, b)).toBe(false);
  });

  it('daemon.maxWorking queues the third spawn and launches it when one finishes', async () => {
    const { m, child, turn, live } = await setup({ daemon: { maxWorking: 2 } });
    const a = await child('a'), b = await child('b'), c = await child('c');
    expect(live(a) && live(b)).toBe(true);
    expect(m.view(c)!.status).toMatchObject({ state: 'queued', activity: 'queued: 2 working, daemon.maxWorking 2' });
    m.applyHook(b, { hook_event_name: 'UserPromptSubmit' }); // working, still holds its slot
    await tick();
    expect(live(c)).toBe(false);
    turn(a);
    await expect.poll(() => live(c)).toBe(true);
  });

  it('a restart with no prompt frees the limits.maxWorking slot of a node whose first turn never began', async () => {
    const { m, child, live } = await setup({ limits: { maxWorking: 1 } });
    const a = await child('a');
    expect(m.restart(a)).toEqual({ ok: true });
    const b = await child('b');
    expect(m.view(b)!.status.state).not.toBe('queued');
    expect(live(b)).toBe(true);
  });

  it('armed nodes survive a manager restart', async () => {
    const { m, open, child } = await setup();
    const a = await child('a');
    const b = await child('b', { afterSuccess: [a] });
    m.shutdown();
    const m2 = open();
    expect(m2.view(b)!.status.state).toBe('armed');
    await m2.resumeLive();
    await expect.poll(() => m2.view(b)!.status.activity).toBe(`after ${a}`);
    expect(m2.session(b)).toBeUndefined();
    m2.setOutcome(a, { outcome: 'succeeded', at: Date.now() });
    await expect.poll(() => !!m2.session(b)).toBe(true);
  });
});
