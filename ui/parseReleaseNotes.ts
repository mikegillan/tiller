// Only recognize Tiller's complete, terminal generator appendix. Other Markdown
// (including headings named Commits) belongs to the author and stays untouched.
const evidence = /^## Commits\n\n((?:- [a-f0-9]{40} [^\n]+\n)+)\nValidated source: [a-f0-9]{40}\n?$/;
const detailsStart = '<details>\n<summary>Technical details</summary>\n\n<!-- tiller-release-evidence:v1 -->\n\n';
const compareOnly = /^(?:\*\*Full Changelog\*\*: https:\/\/github\.com\/[^\s]+\/compare\/[^\s]+)?$/;

function outsideFence(source: string, offset: number): boolean {
  let fence: { char: string; length: number } | undefined;
  for (const line of source.slice(0, offset).split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    if (!fence) {
      if (match[1][0] !== '`' || !match[2].includes('`')) fence = { char: match[1][0], length: match[1].length };
    } else if (match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) fence = undefined;
  }
  return !fence;
}

export function releaseNotes(body: string): { primary: string; original?: string } {
  const unchanged = { primary: body || 'No release notes provided.' };
  const explicit = body.lastIndexOf(detailsStart);
  if (explicit >= 0 && (explicit === 0 || body.slice(0, explicit).endsWith('\n\n')) && outsideFence(body, explicit) && body.endsWith('\n</details>\n')) {
    const appendix = body.slice(explicit + detailsStart.length, -'</details>\n'.length);
    if (evidence.test(appendix)) return { primary: body.slice(0, explicit).trimEnd() || 'No release notes provided.', original: body };
  }
  const start = body.lastIndexOf('## Commits\n\n');
  if (start < 0 || (start > 0 && !body.slice(0, start).endsWith('\n\n')) || !outsideFence(body, start)) return unchanged;
  const match = evidence.exec(body.slice(start));
  if (!match) return unchanged;
  const prefix = body.slice(0, start).trimEnd();
  if (!compareOnly.test(prefix.trim())) return { primary: prefix, original: body };
  const subjects = match[1].trimEnd().split('\n').map(line => line.slice(43))
    .filter(subject => !/^Merge (?:pull request |branch(?:es)? |remote-tracking branch |tag )/.test(subject));
  // Commit subjects are text, not authored Markdown. Escape Markdown punctuation.
  const changes = subjects.map(subject => `- ${subject.replace(/([\\`*{}_\[\]()<>#+.!|~-])/g, '\\$1')}`).join('\n');
  return { primary: [changes || 'No change descriptions provided.', prefix].filter(Boolean).join('\n\n'), original: body };
}
