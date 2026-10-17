// Tiller owns this readable transcript; Codex owns the native thread referenced by its header.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { NodeRecord } from '../shared/protocol.js';

export interface CodexHeader { type: 'codex_session'; threadId: string; fork?: boolean }

export function codexTranscript(sessionDir: string, nodeId: string, sessionId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(sessionId)) throw new Error('invalid Codex session id');
  return join(sessionDir, 'agents', nodeId, `${sessionId}.jsonl`);
}

export function codexHeader(raw: string): CodexHeader {
  const header = JSON.parse(raw.split('\n', 1)[0]);
  if (header?.type !== 'codex_session' || typeof header.threadId !== 'string' || !header.threadId) {
    throw new Error('invalid Codex session header');
  }
  return header;
}

export function prepareCodexTranscript(n: NodeRecord, sessionDir: string, resume: boolean): string {
  if (!n.sessionId) throw new Error('Codex needs a session id');
  const target = codexTranscript(sessionDir, n.id, n.sessionId);
  const source = n.transcriptPath ?? target;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (resume && !existsSync(source)) throw new Error(`missing Codex session transcript (${source})`);
  if (resolve(source) === resolve(target)) {
    if (resume) codexHeader(readFileSync(source, 'utf8'));
    return target;
  }
  // A follow-up forks the native thread, so two nodes never append to the same conversation.
  const copies = [n.sessionId, ...(n.previousSessions ?? [])].flatMap((sid) => {
    const from = sid === n.sessionId ? source : join(dirname(source), `${sid}.jsonl`);
    if (!existsSync(from)) return [];
    const to = codexTranscript(sessionDir, n.id, sid);
    if (existsSync(to)) throw new Error(`Codex session adoption target already exists (${to})`);
    const raw = readFileSync(from, 'utf8'), header = codexHeader(raw);
    const newline = raw.indexOf('\n');
    return [{ to, raw: JSON.stringify({ ...header, fork: true }) + (newline < 0 ? '\n' : raw.slice(newline)) }];
  });
  const created: string[] = [];
  try {
    for (const copy of copies) {
      // Remove only files this adoption created if a later copy fails.
      const fd = openSync(copy.to, 'wx', 0o600);
      created.push(copy.to);
      try { writeFileSync(fd, copy.raw); } finally { closeSync(fd); }
    }
  } catch (error) {
    for (const path of created) rmSync(path, { force: true });
    throw error;
  }
  return target;
}
