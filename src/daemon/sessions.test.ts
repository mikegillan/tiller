import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeManager } from './manager.js';
import { buildDigest, flushEvents, parseSince, readEvents, sessionDir, sweepSessions, type SessionEvent } from './sessions.js';

const DAY = 86_400_000;
const read = (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };

describe('session directories with a fake claude', () => {
  let home = '';
  let m: NodeManager | undefined;
  afterEach(() => { m?.shutdown(); rmSync(home, { recursive: true, force: true }); });

  /** A manager whose claude writes its argv and O8_SESSION_DIR next to the node's settings.json, then idles. */
  function setup() {
    home = mkdtempSync(join(tmpdir(), 'o8-sess-'));
    const bin = join(home, 'bin'), proj = join(home, 'proj');
    mkdirSync(bin);
    mkdirSync(proj);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nfor a in "$@"; do case "$prev" in --settings) d="$(dirname "$a")";; esac; prev="$a"; done\nprintf "%s\\n" "$@" > "$d/argv"\necho "$O8_SESSION_DIR" > "$d/env"\nsleep 5\n');
    chmodSync(join(bin, 'claude'), 0o755);
    m = new NodeManager({ home: join(home, 'o8'), shell: '/bin/sh', path: `${bin}:/usr/bin:/bin` });
    return { m, proj, nodeFile: (id: string, f: string) => join(home, 'o8', 'nodes', id, f) };
  }

  it('creates the root\'s directory with meta.json and gives every node in the tree its path', async () => {
    const { m, proj, nodeFile } = setup();
    const root = (await m.spawn({ kind: 'claude', title: 'root', cwd: proj }));
    const worker = (await m.spawn({ kind: 'claude', title: 'w', cwd: proj, parentId: root.id }));
    const dir = sessionDir(m.home, root.id);
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))).toMatchObject({ rootId: root.id, title: 'root', cwd: proj });
    await expect.poll(() => read(nodeFile(worker.id, 'env'))).toBe(`${dir}\n`);
    await expect.poll(() => read(nodeFile(root.id, 'env'))).toBe(`${dir}\n`);
    expect(read(nodeFile(worker.id, 'argv'))).toContain(`Notes that must outlive your context go in $O8_SESSION_DIR (${dir}); keep handoff.md there`);
  });

  it('restarts with the given prompt, else the handoff pointer when handoff.md exists, else no prompt', async () => {
    const { m, proj, nodeFile } = setup();
    const { id } = (await m.spawn({ kind: 'claude', title: 'root', cwd: proj }));
    const lastArgs = async () => {
      await expect.poll(() => read(nodeFile(id, 'argv'))).not.toBe('');
      const args = read(nodeFile(id, 'argv')).trimEnd().split('\n');
      rmSync(nodeFile(id, 'argv'));
      return args;
    };
    const firstPrompt = (args: string[]) => (args.at(-2) === '--' ? args.at(-1) : undefined);
    expect(firstPrompt(await lastArgs())).toBeUndefined();

    expect(m.restart(id)).toEqual({ ok: true }); // no handoff.md yet
    expect(firstPrompt(await lastArgs())).toBeUndefined();

    const dir = sessionDir(m.home, id);
    writeFileSync(join(dir, 'handoff.md'), '# state\n');
    m.restart(id);
    expect(firstPrompt(await lastArgs())).toBe(`Read ${join(dir, 'handoff.md')} first; it is your own handoff from before this restart.`);

    m.restart(id, 'carry on with step 3');
    expect(firstPrompt(await lastArgs())).toBe('carry on with step 3');
  });

  it('appends events in order and records closedAt when the root closes', async () => {
    const { m, proj } = setup();
    const t0 = Date.now();
    const root = (await m.spawn({ kind: 'claude', title: 'root', cwd: proj }));
    const w = (await m.spawn({ kind: 'claude', title: 'w', cwd: proj, parentId: root.id }));
    m.applyHook(w.id, { hook_event_name: 'UserPromptSubmit', session_id: m.view(w.id)!.status.sessionId, prompt: 'go' });
    m.applyModEvent(w.id, { event: 'turn.complete', payload: { durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } });
    m.applyHook(w.id, { hook_event_name: 'Stop', session_id: m.view(w.id)!.status.sessionId, last_assistant_message: 'all done' }); // after done: still logged
    m.restart(w.id);
    await m.close(w.id);
    await m.close(root.id, true);
    await flushEvents();
    const dir = sessionDir(m.home, root.id);
    const evs = readEvents(dir);
    expect(evs.map((e) => `${e.type}:${e.id === root.id ? 'root' : 'w'}`)).toEqual(['spawn:root', 'spawn:w', 'state:w', 'state:w', 'state:w', 'restart:w', 'close:w', 'close:root']);
    expect(evs[2]).toMatchObject({ from: 'unknown', to: 'working', title: 'w' });
    expect(evs[4]).toMatchObject({ from: 'done', to: 'done', message: 'all done' });
    expect(evs.every((e, i) => e.ts >= t0 && (i === 0 || e.ts >= evs[i - 1]!.ts))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).closedAt).toBeGreaterThanOrEqual(t0);
  });
});

describe('sweepSessions', () => {
  let home = '';
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('deletes only the directories of gone roots that closed, or went quiet, more than keepDays ago', () => {
    home = mkdtempSync(join(tmpdir(), 'o8-sweep-'));
    const now = Date.now();
    const make = (id: string, meta: object | null, mtime: number) => {
      const dir = sessionDir(home, id);
      mkdirSync(dir, { recursive: true });
      if (meta) writeFileSync(join(dir, 'meta.json'), JSON.stringify({ rootId: id, title: id, cwd: '/', createdAt: now - 30 * DAY, ...meta }));
      writeFileSync(join(dir, 'handoff.md'), 'x');
      for (const f of [join(dir, 'handoff.md'), ...(meta ? [join(dir, 'meta.json')] : []), dir]) utimesSync(f, mtime / 1000, mtime / 1000);
    };
    make('closed-old', { closedAt: now - 20 * DAY }, now - 20 * DAY);
    make('closed-recent', { closedAt: now - 2 * DAY }, now - 20 * DAY); // closedAt wins over old files
    make('gone-quiet', null, now - 20 * DAY);                            // no meta, root gone, nothing written for 20 days
    make('gone-active', null, now - DAY);
    make('live-old', {}, now - 90 * DAY);                                // root still registered: never swept
    expect(sweepSessions(home, new Set(['live-old']), 14, now).sort()).toEqual(['closed-old', 'gone-quiet']);
    for (const id of ['closed-recent', 'gone-active', 'live-old']) expect(existsSync(sessionDir(home, id))).toBe(true);
    expect(existsSync(sessionDir(home, 'closed-old'))).toBe(false);
  });
});

describe('event log reading', () => {
  it('filters by --since', () => {
    const dir = mkdtempSync(join(tmpdir(), 'o8-log-'));
    const now = Date.now();
    writeFileSync(join(dir, 'events.jsonl'), [
      { ts: now - 3 * 3_600_000, type: 'spawn', id: 'a' },
      { ts: now - 3_600_000, type: 'state', id: 'a', from: 'working', to: 'done' },
      { ts: now - 60_000, type: 'close', id: 'a' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n');
    expect(parseSince('2h')).toBe(2 * 3_600_000);
    expect(parseSince('15m')).toBe(15 * 60_000);
    expect(parseSince('2 hours')).toBeUndefined();
    expect(readEvents(dir, now - parseSince('2h')!).map((e) => e.type)).toEqual(['state', 'close']);
    expect(readEvents(dir).length).toBe(3); // the bad line is skipped
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('buildDigest', () => {
  it('reports each node\'s latest state, needs-you first, then errored, then finished, newest first within', () => {
    const ev = (ts: number, type: string, id: string, rest: object = {}): SessionEvent => ({ ts, type, id, title: id.toUpperCase(), ...rest });
    const log = [
      ev(1, 'state', 'done1', { from: 'working', to: 'done', message: 'all green' }),
      ev(2, 'outcome', 'done1', { outcome: 'succeeded', note: 'merged the fix' }),
      ev(3, 'state', 'ask', { from: 'working', to: 'waiting', message: 'Which port should I use?' }),
      ev(4, 'state', 'perm', { from: 'working', to: 'blocked', activity: 'needs approval: Bash rm -rf build' }),
      ev(5, 'state', 'answered', { from: 'working', to: 'blocked', activity: 'needs approval: x' }),
      ev(6, 'state', 'answered', { from: 'blocked', to: 'working' }),            // was blocked, no longer: nothing to report
      ev(7, 'state', 'crash', { from: 'working', to: 'done', errored: true, activity: 'API error' }),
      ev(8, 'outcome', 'failed', { outcome: 'failed', note: 'tests do not pass' }),
      ev(9, 'state', 'done2', { from: 'working', to: 'done', message: 'wrote the README' }),
      ev(10, 'cost', 'done2', { usd: 1.2 }),
      ev(11, 'spawn', 'fresh'),
    ];
    expect(buildDigest(log).map((i) => [i.kind, i.id, i.text])).toEqual([
      ['needsYou', 'perm', 'needs approval: Bash rm -rf build'],
      ['needsYou', 'ask', 'Which port should I use?'],
      ['errored', 'failed', 'tests do not pass'],
      ['errored', 'crash', 'API error'],
      ['finished', 'done2', 'wrote the README'],
      ['finished', 'done1', 'merged the fix'],
    ]);
    expect(buildDigest(log)[0]!.title).toBe('PERM');
  });
});
