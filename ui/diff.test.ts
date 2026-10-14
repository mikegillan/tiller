import { describe, expect, it } from 'vitest';
import { formatComments, parsePatch } from './diff';

describe('diff view', () => {
  it('numbers lines in the old and new file from the hunk header', () => {
    const patch = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -3,3 +3,3 @@ fn\n keep\n-old\n+new\n\\ No newline at end of file\n';
    expect(parsePatch(patch)).toEqual([
      { kind: 'hunk', text: '@@ -3,3 +3,3 @@ fn' },
      { kind: 'ctx', text: ' keep', old: 3, new: 3 },
      { kind: 'del', text: '-old', old: 4 },
      { kind: 'add', text: '+new', new: 4 },
      { kind: 'meta', text: '\\ No newline at end of file' },
    ]);
  });

  it('formats comments as one message, quoting each line', () => {
    expect(formatComments('tl/n-1', [
      { nodeId: 'n-1', path: 'src/a.ts', line: 12, text: '+const x = 1;', note: 'Name this.' },
      { nodeId: 'n-1', path: 'README', line: 3, text: '-old text', note: 'Why remove it?\nIt is still true.' },
    ])).toBe('Review comment on src/a.ts line 12 (tl/n-1):\n> +const x = 1;\nName this.\n\n'
      + 'Review comment on README line 3 (tl/n-1):\n> -old text\nWhy remove it?\nIt is still true.');
  });
});
