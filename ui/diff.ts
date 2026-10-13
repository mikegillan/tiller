// Pure helpers for the diff view: patch lines with their numbers, and review comments as one message.

export interface DiffLine { kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'; text: string; old?: number; new?: number }

/** The lines of one file's unified diff from its first hunk on, numbered in the old and new file. */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let o = 0, n = 0, inHunk = false;
  for (const text of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(text);
    if (h) { o = Number(h[1]); n = Number(h[2]); inHunk = true; out.push({ kind: 'hunk', text }); continue; }
    if (!inHunk || text === '') continue; // the header before the first hunk, and the end of the patch
    if (text[0] === '+') out.push({ kind: 'add', text, new: n++ });
    else if (text[0] === '-') out.push({ kind: 'del', text, old: o++ });
    else if (text[0] === ' ') out.push({ kind: 'ctx', text, old: o++, new: n++ });
    else out.push({ kind: 'meta', text }); // "\ No newline at end of file"
  }
  return out;
}

/** A note on one diff line. `text` is the line as the diff shows it, with its +, - or space; `line` numbers the new file, or the old one for a removed line. */
export interface ReviewComment { nodeId: string; path: string; line: number; text: string; note: string }

export const formatComments = (branch: string, comments: ReviewComment[]): string =>
  comments.map((c) => `Review comment on ${c.path} line ${c.line} (${branch}):\n> ${c.text}\n${c.note}`).join('\n\n');
