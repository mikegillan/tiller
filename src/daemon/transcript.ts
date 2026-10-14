// Claude's transcript files (one JSON object per line, <sessionId>.jsonl in a per-project directory under ~/.claude/projects),
// read as the user and assistant messages of a conversation.
import { existsSync, realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Transcript, TranscriptEntry } from '../shared/protocol.js';

/** The most recent messages a transcript read returns. */
export const MAX_ENTRIES = 2000;
/** How much of the end of a transcript file is read; older lines are cut. */
export const TAIL_BYTES = 8 << 20;

/** One user or assistant message with its text and tool calls in content order. */
export interface Message { role: 'user' | 'assistant'; at?: number; parts: Array<{ text: string } | { tool: string }> }
type Node = { cwd: string; sessionId?: string; previousSessions?: string[]; transcriptPath?: string };

/** Fallback for where Claude keeps a session's transcript: the real path of cwd with every non-alphanumeric character replaced by -. */
export function transcriptFor(cwd: string, sessionId: string): string {
  let real = cwd;
  try { real = realpathSync(cwd); } catch { /* keep the path as given */ }
  return join(homedir(), '.claude', 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

/** The user and assistant messages of a transcript file's text. Tool results and lines with neither text nor tool calls are dropped. */
export function parseMessages(raw: string): Message[] {
  return raw.split('\n').flatMap((line) => {
    let e: { type?: string; timestamp?: unknown; message?: { content?: unknown } };
    try { e = JSON.parse(line); } catch { return []; }
    if (e?.type !== 'user' && e?.type !== 'assistant') return [];
    const c = e.message?.content;
    const blocks: Array<{ type?: string; text?: string; name?: string }> = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    const parts = blocks.flatMap((b): Message['parts'] => (b?.type === 'text' && b.text?.trim() ? [{ text: b.text.trim() }] : b?.type === 'tool_use' && b.name ? [{ tool: b.name }] : []));
    if (!parts.length) return [];
    const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    return [{ role: e.type, parts, ...(Number.isNaN(at) ? {} : { at }) }];
  });
}

export function toEntry(m: Message): TranscriptEntry {
  const text = m.parts.flatMap((p) => ('text' in p ? [p.text] : [])).join('\n');
  const tools = m.parts.flatMap((p) => ('tool' in p ? [p.tool] : []));
  return { role: m.role, ...(m.at !== undefined ? { at: m.at } : {}), text, ...(tools.length ? { tools } : {}) };
}

export const parseTranscript = (raw: string): TranscriptEntry[] => parseMessages(raw).map(toEntry);

/** One message as text, as `tl read` prints it: tool calls become a "[tool: name]" marker where they occur. */
export const renderMessage = (m: Message): string => `${m.role}: ${m.parts.map((p) => ('text' in p ? p.text : `[tool: ${p.tool}]`)).join('\n')}`;

/** The last MAX_ENTRIES messages of a transcript file, reading at most its last TAIL_BYTES. */
export async function readMessages(path: string): Promise<{ messages: Message[]; truncated: boolean }> {
  const f = await open(path, 'r');
  try {
    const { size } = await f.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await f.read(buf, 0, buf.length, start);
    let raw = buf.toString('utf8');
    if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1); // the first line is cut
    const all = parseMessages(raw);
    return { messages: all.slice(-MAX_ENTRIES), truncated: start > 0 || all.length > MAX_ENTRIES };
  } finally {
    await f.close();
  }
}

/**
 * A node's messages in session `sessionId` (default: its current one). A previous session's file sits next to the
 * current one: Claude keeps every session of a project in one directory.
 */
export async function sessionMessages(n: Node, sessionId?: string): Promise<{ messages: Message[]; truncated: boolean; sessions: Transcript['sessions'] }> {
  if (!n.sessionId) throw new Error('no session on record');
  const current = n.transcriptPath ?? transcriptFor(n.cwd, n.sessionId);
  const sessions = [n.sessionId, ...[...(n.previousSessions ?? [])].reverse()].map((s) => ({ sessionId: s, current: s === n.sessionId }));
  const sid = sessionId ?? n.sessionId;
  if (!sessions.some((s) => s.sessionId === sid)) throw new Error(`no session ${sid} on record for this node`);
  const path = sid === n.sessionId ? current : join(dirname(current), `${sid}.jsonl`);
  if (!existsSync(path)) throw new Error(`the transcript of session ${sid} is gone (${path})`);
  return { ...(await readMessages(path)), sessions };
}

export async function nodeTranscript(n: Node, sessionId?: string): Promise<Transcript> {
  const { messages, truncated, sessions } = await sessionMessages(n, sessionId);
  return { entries: messages.map(toEntry), sessions, ...(truncated ? { truncated } : {}) };
}
