import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { briefOf, history } from './archive.js';
import { NodeManager } from './manager.js';
import { nodeTranscript, parseMessages, parseTranscript, readMessages, renderMessage, TAIL_BYTES } from './transcript.js';

const line = (o: object) => JSON.stringify(o);
const FIXTURE = [
  line({ type: 'user', timestamp: '2026-10-13T10:00:00.000Z', message: { role: 'user', content: 'fix the bug' } }),
  line({ type: 'assistant', timestamp: '2026-10-13T10:00:05.000Z', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Bash', input: {} }] } }),
  line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }), // a tool result: dropped
  line({ type: 'summary', summary: 'x' }), // not a message
  'not json',
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed.' }] } }),
].join('\n');

describe('transcript', () => {
  it('reads user and assistant messages with their time and tool calls', () => {
    expect(parseTranscript(FIXTURE)).toEqual([
      { role: 'user', text: 'fix the bug', at: Date.parse('2026-10-13T10:00:00Z') },
      { role: 'assistant', text: 'Looking.', at: Date.parse('2026-10-13T10:00:05Z'), tools: ['Bash'] },
      { role: 'assistant', text: 'Fixed.' },
    ]);
  });

  it('lists the sessions current first and reads a previous one from the same directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'o8-tr-'));
    writeFileSync(join(dir, 'cur.jsonl'), FIXTURE);
    writeFileSync(join(dir, 'old2.jsonl'), line({ type: 'user', message: { content: 'earlier' } }));
    const n = { cwd: dir, sessionId: 'cur', previousSessions: ['old1', 'old2'], transcriptPath: join(dir, 'cur.jsonl') };
    const t = await nodeTranscript(n);
    expect(t.sessions).toEqual([{ sessionId: 'cur', current: true }, { sessionId: 'old2', current: false }, { sessionId: 'old1', current: false }]);
    expect(t.entries).toHaveLength(3);
    expect((await nodeTranscript(n, 'old2')).entries).toEqual([{ role: 'user', text: 'earlier' }]);
    await expect(nodeTranscript(n, 'old1')).rejects.toThrow(/session old1 is gone/);
    await expect(nodeTranscript(n, 'other')).rejects.toThrow(/no session other on record/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders text and tool calls in content order', () => {
    const [m] = parseMessages(line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'text', text: 'Then this.' }, { type: 'tool_use', name: 'Bash' }] } }));
    expect(renderMessage(m!)).toBe('assistant: [tool: Read]\nThen this.\n[tool: Bash]');
  });

  it('reads only the tail of a large file, dropping the cut line, and says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'o8-tr-'));
    const one = `${line({ type: 'user', message: { content: 'x'.repeat(1000) } })}\n`;
    const path = join(dir, 'big.jsonl');
    writeFileSync(path, one.repeat(Math.ceil(TAIL_BYTES / one.length) + 10) + line({ type: 'user', message: { content: 'last' } }));
    const r = await readMessages(path);
    expect(r.truncated).toBe(true);
    expect(r.messages.at(-1)).toEqual({ role: 'user', parts: [{ text: 'last' }] });
    expect(r.messages.every((x) => 'text' in x.parts[0]! && (x.parts[0].text === 'last' || x.parts[0].text.length === 1000))).toBe(true);
    expect((await readMessages(join(dir, 'big.jsonl'))).messages.length).toBeLessThanOrEqual(2000);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('briefOf', () => {
  const base = { id: 'n-1', rootId: 'n-0', parentId: 'n-0', title: 't', cwd: '/', createdAt: 0, closedAt: 1 };
  it('leads with the outcome and its summary\'s first sentence, else the last message, else the prompt; ends with the branch fate', () => {
    expect(briefOf({ ...base, outcome: { outcome: 'succeeded', summary: 'Added the flag. Also tests.', at: 0 }, branch: 'o8/n-1', branchFate: 'merged', base: 'main' }))
      .toBe('succeeded: Added the flag. (merged into main)');
    expect(briefOf({ ...base, outcome: { outcome: 'failed', note: 'tests fail', at: 0 }, branchFate: 'kept' })).toBe('failed: tests fail (branch kept, unmerged)');
    expect(briefOf({ ...base, lastAssistantMessage: '\nDone with it.\nMore.', prompt: 'p', branchFate: 'discarded' })).toBe('Done with it. (branch discarded)');
    expect(briefOf({ ...base, prompt: 'write docs\nplease' })).toBe('write docs');
    const long = briefOf({ ...base, lastAssistantMessage: 'x'.repeat(500), branchFate: 'kept' })!;
    expect(long).toHaveLength(200);
    expect(long.endsWith('… (branch kept, unmerged)')).toBe(true);
  });
});

describe('archive, history, follow-up and fork', () => {
  let home = '';
  let m: NodeManager;
  afterEach(() => { m.shutdown(); rmSync(home, { recursive: true, force: true }); });

  /** A manager whose `claude` writes its argv to <node dir>/argv and idles. */
  const setup = () => {
    home = mkdtempSync(join(tmpdir(), 'o8-arch-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nfor a in "$@"; do case "$prev" in --settings) out="$(dirname "$a")/argv";; esac; prev="$a"; done\necho "$@" > "$out"\nsleep 5\n');
    chmodSync(join(bin, 'claude'), 0o755);
    m = new NodeManager({ home, shell: '/bin/sh', path: `${bin}:/usr/bin:/bin` });
  };
  const argv = async (id: string) => {
    const file = join(home, 'nodes', id, 'argv');
    await expect.poll(() => { try { return readFileSync(file, 'utf8'); } catch { return ''; } }).not.toBe('');
    return readFileSync(file, 'utf8');
  };
  /** A started claude node: SessionStart has given it a transcript. */
  const started = async (title: string, parentId: string | null, prompt?: string) => {
    const { id } = await m.spawn({ kind: 'claude', title, cwd: home, parentId, prompt, byHuman: true });
    const transcriptPath = join(home, `${m.registry.get(id)!.sessionId}.jsonl`);
    writeFileSync(transcriptPath, FIXTURE);
    m.applyHook(id, { hook_event_name: 'SessionStart', session_id: m.registry.get(id)!.sessionId, transcript_path: transcriptPath });
    return id;
  };

  it('archives a closed Claude node with its prompt, outcome and branch fate, not a terminal; history filters by query and tree', async () => {
    setup();
    const root = await started('root', null, 'lead the work');
    const a = await started('parser', root, 'write the parser');
    const b = await started('docs', root, 'write the docs');
    const c = await started('cleanup', root);
    const t = (await m.spawn({ kind: 'terminal', title: 'term', cwd: home, parentId: root })).id;
    m.setOutcome(a, { outcome: 'succeeded', summary: 'Parser done. Tests pass.', at: 1 });
    m.registry.update(a, { worktree: { repo: home, path: join(home, 'wt'), branch: `o8/${a}`, base: 'main', baseSha: 'x' }, spentUsd: 0.5 });
    m.closed(a, undefined, { branchFate: 'merged', base: 'main' }); // what closeWorktreeNode passes for a merged branch
    m.closed(b, 'kept branch o8/b', { branchFate: 'kept' });
    m.closed(c, undefined, { branchFate: 'discarded' });
    await m.close(t);
    const other = await started('elsewhere', null, 'unrelated parser');
    await m.close(other, true);

    const all = await history(home);
    expect(all.map((x) => x.id).sort()).toEqual([a, b, c, other].sort());
    expect(all.find((x) => x.id === a)).toMatchObject({
      rootId: root, parentId: root, title: 'parser', prompt: 'write the parser', role: 'worker', outcome: { outcome: 'succeeded' },
      branch: `o8/${a}`, branchFate: 'merged', base: 'main', spentUsd: 0.5, sessionId: expect.any(String), transcriptPath: expect.stringContaining('.jsonl'),
      brief: 'succeeded: Parser done. (merged into main)', closedAt: expect.any(Number),
    });
    expect(all.find((x) => x.id === b)).toMatchObject({ branchFate: 'kept', brief: 'write the docs (branch kept, unmerged)' });
    expect(all.find((x) => x.id === c)).toMatchObject({ branchFate: 'discarded', brief: '(branch discarded)' });
    expect(all[0]!.closedAt).toBeGreaterThanOrEqual(all.at(-1)!.closedAt);
    expect((await history(home, { query: 'PARSER' })).map((x) => x.id).sort()).toEqual([a, other].sort());
    expect((await history(home, { query: 'parser', rootId: root })).map((x) => x.id)).toEqual([a]);
  });

  it('archives every node of a tree under its root, through prune (root first in the registry) and after a forced root close', async () => {
    setup();
    const root = await started('root', null);
    const kid = await started('kid', root);
    const grandkid = await started('grandkid', kid);
    for (const id of [root, kid, grandkid]) process.kill(m.session(id)!.pid, 'SIGKILL');
    await expect.poll(() => [root, kid, grandkid].every((id) => m.view(id)!.status.exited)).toBe(true);
    expect((await m.prune()).removed).toHaveLength(3);
    expect((await history(home, { rootId: root })).map((a) => [a.id, a.rootId]).sort()).toEqual([[grandkid, root], [kid, root], [root, root]].sort());

    const root2 = await started('root2', null);
    const kid2 = await started('kid2', root2);
    await m.close(root2, true);
    await m.close(kid2); // its root is gone; it still belongs to root2's tree
    expect((await history(home, { rootId: root2 })).map((a) => a.id).sort()).toEqual([kid2, root2].sort());
  });

  it('refuses a second follow-up of the same session while the first is live', async () => {
    setup();
    const a = await started('worker', null);
    await m.close(a, true);
    const f = await m.followup(a, 'more');
    await expect(m.followup(a, 'again')).rejects.toThrow(`refused: ${f.id} already continues the session of ${a}; send it the prompt instead`);
  });

  it('an armed fork keeps its own session id until it launches, and is not archived if closed before', async () => {
    setup();
    const root = await started('root', null);
    const src = await started('source', root);
    const srcSid = m.registry.get(src)!.sessionId!;
    const f = await m.spawn({ kind: 'claude', title: 'fork', cwd: '', parentId: root, fork: src, after: [root], byHuman: true });
    expect(f.status.state).toBe('armed');
    expect(m.registry.get(f.id)).toMatchObject({ forkSession: srcSid, sessionId: expect.not.stringMatching(srcSid) });
    await m.close(f.id);
    expect((await history(home)).map((a) => a.id)).not.toContain(f.id);
  });

  it('follows up an archived node with claude --resume and the prompt, under its live parent; refuses an unknown id', async () => {
    setup();
    const root = await started('root', null);
    const a = await started('worker', root, 'first task');
    const sid = m.registry.get(a)!.sessionId!;
    await m.close(a);
    const f = await m.followup(a, 'second task');
    expect(f).toMatchObject({ parentId: root, title: 'worker', followupOf: a, sessionId: sid, prompt: 'second task' });
    const args = await argv(f.id);
    expect(args).toMatch(new RegExp(`^--resume ${sid} --name worker`));
    expect(args.trimEnd().endsWith('-- second task')).toBe(true);
    await expect(m.followup('n-nope', 'x')).rejects.toThrow('no archived node n-nope');
  });

  it('a follow-up does not count the resumed session\'s earlier spend again', async () => {
    setup();
    const a = await started('worker', null, 'task');
    const measure = (id: string, usd: number) => m.applyModEvent(id, { event: 'session.measure', payload: { cost: { usd } } });
    measure(a, 0.5);
    measure(a, 0.8);
    await m.close(a, true);
    const f = await m.followup(a, 'more');
    measure(f.id, 1.0); // the resumed session's counter carries on from 0.8
    expect(m.view(f.id)!.spentUsd).toBeCloseTo(0.2);
  });

  it('forks a live or archived node with --fork-session under a new session id; refuses one that has not started', async () => {
    setup();
    const root = await started('root', null);
    const src = await started('source', root);
    const srcSid = m.registry.get(src)!.sessionId!;
    const f = await m.spawn({ kind: 'claude', title: 'fork', cwd: '', parentId: root, fork: src, prompt: 'try another way', byHuman: true });
    const args = await argv(f.id);
    const newSid = m.registry.get(f.id)!.sessionId!;
    expect(newSid).not.toBe(srcSid);
    expect(args.startsWith(`--resume ${srcSid} --fork-session --session-id ${newSid} `)).toBe(true);
    expect(args.trimEnd().endsWith('-- try another way')).toBe(true);
    expect(m.registry.get(f.id)).toMatchObject({ forkOf: src, cwd: home });
    expect(m.registry.get(f.id)!.forkSession).toBeUndefined(); // cleared at launch, so a restart starts fresh
    await m.close(src);
    const g = await m.spawn({ kind: 'claude', title: 'fork2', cwd: '', parentId: root, fork: src, byHuman: true }); // archived source
    expect(await argv(g.id)).toContain(`--resume ${srcSid} --fork-session`);
    const fresh = (await m.spawn({ kind: 'claude', title: 'fresh', cwd: home, parentId: root, byHuman: true })).id;
    await expect(m.spawn({ kind: 'claude', title: 'x', cwd: '', fork: fresh, byHuman: true })).rejects.toThrow(/has no Claude session yet/);
    await expect(m.spawn({ kind: 'terminal', title: 'x', cwd: '', fork: src, byHuman: true })).rejects.toThrow(/claude nodes only/);
  });
});
