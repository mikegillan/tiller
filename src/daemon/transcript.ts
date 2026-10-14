// Claude's transcript files (one JSON object per line, <sessionId>.jsonl in a per-project directory under ~/.claude/projects),
// read as the user and assistant messages of a conversation.
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Transcript, TranscriptEntry } from '../shared/protocol.js';

/** The most recent entries a Transcript reply carries. */
export const MAX_ENTRIES = 2000;

/** Fallback for where Claude keeps a session's transcript: the real path of cwd with every non-alphanumeric character replaced by -. */
export function transcriptFor(cwd: string, sessionId: string): string {
  let real = cwd;
  try { real = realpathSync(cwd); } catch { /* keep the path as given */ }
  return join(homedir(), '.claude', 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

/** The user and assistant messages of a transcript file's text. Tool results and lines with neither text nor tool calls are dropped. */
export function parseTranscript(raw: string): TranscriptEntry[] {
  return raw.split('\n').flatMap((line) => {
    let e: { type?: string; timestamp?: unknown; message?: { content?: unknown } };
    try { e = JSON.parse(line); } catch { return []; }
    if (e?.type !== 'user' && e?.type !== 'assistant') return [];
    const c = e.message?.content;
    const blocks: Array<{ type?: string; text?: string; name?: string }> = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    const text = blocks.flatMap((b) => (b?.type === 'text' && b.text ? [b.text] : [])).join('\n').trim();
    const tools = blocks.flatMap((b) => (b?.type === 'tool_use' && b.name ? [b.name] : []));
    if (!text && !tools.length) return [];
    const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    return [{ role: e.type, text, ...(Number.isNaN(at) ? {} : { at }), ...(tools.length ? { tools } : {}) }];
  });
}

/** One entry as text, as `o8 read` prints it: tool calls become a "[tool: name]" marker. */
export const renderEntry = (e: TranscriptEntry): string =>
  `${e.role}: ${[e.text, ...(e.tools ?? []).map((t) => `[tool: ${t}]`)].filter(Boolean).join('\n')}`;

export async function readTranscript(path: string): Promise<TranscriptEntry[]> {
  return parseTranscript(await readFile(path, 'utf8'));
}

/**
 * A node's conversation in session `sessionId` (default: its current one), the most recent MAX_ENTRIES entries. A
 * previous session's file sits next to the current one: Claude keeps every session of a project in one directory.
 */
export async function nodeTranscript(n: { cwd: string; sessionId?: string; previousSessions?: string[]; transcriptPath?: string }, sessionId?: string): Promise<Transcript> {
  if (!n.sessionId) throw new Error('no session on record');
  const current = n.transcriptPath ?? transcriptFor(n.cwd, n.sessionId);
  const sessions = [n.sessionId, ...[...(n.previousSessions ?? [])].reverse()].map((s) => ({ sessionId: s, current: s === n.sessionId }));
  const sid = sessionId ?? n.sessionId;
  if (!sessions.some((s) => s.sessionId === sid)) throw new Error(`no session ${sid} on record for this node`);
  const path = sid === n.sessionId ? current : join(dirname(current), `${sid}.jsonl`);
  if (!existsSync(path)) throw new Error(`the transcript of session ${sid} is gone (${path})`);
  const all = await readTranscript(path);
  return { entries: all.slice(-MAX_ENTRIES), sessions, ...(all.length > MAX_ENTRIES ? { truncated: true } : {}) };
}
