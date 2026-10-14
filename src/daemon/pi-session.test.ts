import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeRecord } from '../shared/protocol.js';
import { piTranscript, preparePiTranscript } from './pi-session.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tl-pi-session-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
const fixture = (cwd: string) => JSON.stringify({ type: 'session', version: 3, id: 'native-id', cwd, timestamp: '2026-01-01', extra: { opaque: true } }) + '\n' +
  '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"hi"}}\n' +
  '{"type":"custom","id":"x1","parentId":"u1","customType":"unknown","data":{"opaque":true}}\n' +
  '{"type":"compaction","id":"c1","parentId":"x1","firstKeptEntryId":"u1","summary":"summary"}\n';
const node = (transcriptPath?: string): NodeRecord => ({ id: 'n-new', title: 'test', parentId: null, kind: 'agent', harness: 'pi', cwd: home, sessionId: 'current', createdAt: 1, transcriptPath });
const write = (path: string, raw: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, raw); };

describe('Pi owned session storage', () => {
  it('adopts legacy cross-root transcripts and prior sessions while preserving identity, metadata and every entry', () => {
    const source = join(home, 'old-root', 'agents', 'n-old', 'current.jsonl');
    const raw = fixture('/removed/worktree');
    write(source, raw); write(join(dirname(source), 'previous.jsonl'), raw);
    const dir = join(home, 'new-root');
    const n = { ...node(source), previousSessions: ['previous', 'already-missing'] };
    const path = preparePiTranscript(n, dir);
    expect(path).toBe(piTranscript(dir, n.id, 'current'));
    expect(readFileSync(source, 'utf8')).toBe(raw);
    for (const sid of ['current', 'previous']) {
      const adopted = readFileSync(piTranscript(dir, n.id, sid), 'utf8');
      expect(JSON.parse(adopted.split('\n')[0])).toEqual({ ...JSON.parse(raw.split('\n')[0]!), cwd: home });
      expect(adopted.slice(adopted.indexOf('\n'))).toBe(raw.slice(raw.indexOf('\n')));
    }
    expect(preparePiTranscript({ ...n, transcriptPath: path }, dir)).toBe(path); // idempotent resume
  });

  it('cleans up newly created copies after a write failure without altering source sessions', async () => {
    const source = join(home, 'old-root', 'current.jsonl'), dir = join(home, 'new-root');
    const raw = fixture('/removed');
    write(source, raw); write(join(dirname(source), 'previous.jsonl'), raw);
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(writeFileSync)
      .mockImplementationOnce(actual.writeFileSync) // Current copy succeeds.
      .mockImplementationOnce((file) => {
        actual.writeFileSync(file, 'partial');
        throw new Error('simulated copy write failure');
      });
    const n = { ...node(source), previousSessions: ['previous'] };
    expect(() => preparePiTranscript(n, dir, true)).toThrow('simulated copy write failure');
    expect(existsSync(piTranscript(dir, n.id, 'current'))).toBe(false);
    expect(existsSync(piTranscript(dir, n.id, 'previous'))).toBe(false);
    expect(readFileSync(source, 'utf8')).toBe(raw);
    expect(readFileSync(join(dirname(source), 'previous.jsonl'), 'utf8')).toBe(raw);
    expect(preparePiTranscript(n, dir, true)).toBe(piTranscript(dir, n.id, 'current')); // Retry is safe.
  });

  it('repairs an owned header cwd on resume without rewriting entries or copying again', () => {
    const dir = join(home, 'root'), n = node();
    const path = piTranscript(dir, n.id, n.sessionId!);
    write(path, fixture('/removed'));
    expect(preparePiTranscript({ ...n, transcriptPath: path }, dir)).toBe(path);
    expect(JSON.parse(readFileSync(path, 'utf8').split('\n')[0]).cwd).toBe(home);
  });

  it('keeps the owned transcript intact and removes the temp file if cwd repair fails mid-write', async () => {
    const dir = join(home, 'root'), n = node();
    const path = piTranscript(dir, n.id, n.sessionId!), raw = fixture('/removed');
    write(path, raw);
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(writeFileSync).mockImplementationOnce((file) => {
      actual.writeFileSync(file, 'partial');
      throw new Error('simulated partial write');
    });
    expect(() => preparePiTranscript({ ...n, transcriptPath: path }, dir, true)).toThrow('simulated partial write');
    expect(readFileSync(path, 'utf8')).toBe(raw);
    expect(readdirSync(dirname(path))).toEqual(['current.jsonl']);
  });

  it('adopts recorded history when restarting a legacy cross-root record into a fresh empty session', () => {
    const dir = join(home, 'new-root');
    const source = join(home, 'old-root', 'current.jsonl'); // The restart's new session does not exist yet.
    write(join(dirname(source), 'previous.jsonl'), fixture('/removed'));
    const n = { ...node(source), previousSessions: ['previous'] };
    expect(() => preparePiTranscript(n, dir, true)).toThrow(/ENOENT/); // Missing current history cannot be resumed.
    const target = preparePiTranscript(n, dir, false);
    expect(existsSync(target)).toBe(false);
    expect(JSON.parse(readFileSync(piTranscript(dir, n.id, 'previous'), 'utf8').split('\n')[0]).cwd).toBe(home);
  });

  it('leaves a new session uncreated for Pi and fails closed on malformed headers or adoption collisions', () => {
    const dir = join(home, 'root'), n = node();
    const target = preparePiTranscript(n, dir);
    expect(existsSync(target)).toBe(false);
    const source = join(home, 'source.jsonl');
    write(source, '{"type":"message"}\n');
    expect(() => preparePiTranscript(node(source), dir)).toThrow(/invalid Pi session header/);
    expect(existsSync(target)).toBe(false);
    write(source, fixture(home)); write(target, fixture(home));
    expect(() => preparePiTranscript(node(source), dir)).toThrow(/target already exists/);
    expect(() => piTranscript(dir, n.id, '../escape')).toThrow(/invalid Pi session id/);
  });
});
