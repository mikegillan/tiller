// The readable transcript references Codex's native thread; it never replaces native history.
export interface CodexHeader { type: 'codex_session'; threadId: string; fork?: boolean }

export function codexHeader(raw: string): CodexHeader {
  const header = JSON.parse(raw.split('\n', 1)[0]);
  if (header?.type !== 'codex_session' || typeof header.threadId !== 'string' || !header.threadId) {
    throw new Error('invalid Codex session header');
  }
  return header;
}
