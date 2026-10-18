import { expect, it } from 'vitest';
import { releaseNotes } from './parseReleaseNotes';
import historicalReleases from './fixtures/releases-v0.1.2-v0.1.4.json';

const sha = 'a'.repeat(40);
const appendix = `## Commits\n\n- ${sha} Improve release notes\n- ${'b'.repeat(40)} Merge pull request #7 from example/readable\n- ${'c'.repeat(40)} Fix [links] and *emphasis*\n\nValidated source: ${sha}\n`;
const compare = '**Full Changelog**: https://github.com/example/tiller/compare/v0.1.2...v0.1.3';
const explicit = `<details>\n<summary>Technical details</summary>\n\n<!-- tiller-release-evidence:v1 -->\n\n${appendix}</details>\n`;

it('turns the exact legacy generated body into actual change descriptions and retains all original evidence', () => {
  const body = `${compare}\n\n${appendix}`;
  const notes = releaseNotes(body);
  expect(notes.primary).toBe(`- Improve release notes\n- Fix \\[links\\] and \\*emphasis\\*\n\n${compare}`);
  expect(notes.primary).not.toContain(sha);
  expect(notes.primary).not.toContain('Merge pull request');
  expect(notes.original).toBe(body);
});

it('prefers authored PR notes and preserves their headings, links and code exactly', () => {
  const prefix = '## What\'s Changed\n\n* Improve the updater by @example in #7\n\n## Commits\n\nAn authored explanation.\n\n```text\nValidated source: example\n```';
  expect(releaseNotes(`${prefix}\n\n${appendix}`)).toEqual({ primary: prefix, original: `${prefix}\n\n${appendix}` });
});

it('supports the explicit future evidence block without duplicating the primary notes', () => {
  const body = `- Readable changes\n\n${explicit}`;
  expect(releaseNotes(body)).toEqual({ primary: '- Readable changes', original: body });
});

it('falls back without a PR summary or compare link and never invents a merge description', () => {
  expect(releaseNotes(appendix).primary).toContain('- Improve release notes');
  const mergeOnly = `## Commits\n\n- ${sha} Merge branch 'main'\n\nValidated source: ${sha}\n`;
  expect(releaseNotes(mergeOnly)).toEqual({ primary: 'No change descriptions provided.', original: mergeOnly });
});

it.each([
  `# Authored notes\n\n## Commits\n\n- ${sha} A real bullet`,
  `${appendix}\nAn authored ending.`,
  appendix.replace('Validated source:', 'Source:'),
  `\`\`\`markdown\n${appendix}`,
  `~~~markdown\n${appendix}`,
  `\`\`\`\`markdown\n\`\`\`\n${appendix}`,
  `\`\`\`html\n${explicit}`,
  explicit.replace('evidence:v1', 'evidence:v2'),
  '## Commits\n\nA normal heading\n\nValidated source: not-a-sha',
])('preserves unknown formats and authored Markdown untouched: %s', (body) => {
  expect(releaseNotes(body)).toEqual({ primary: body });
});

it('recognizes an appendix after a closed fence without modifying the fenced content', () => {
  const prefix = `~~~\n${appendix}~~~`;
  expect(releaseNotes(`${prefix}\n\n${appendix}`).primary).toBe(prefix);
});

// Public historical release bodies, kept exact so the migration behavior cannot
// drift away from what already-installed users actually receive.
it('makes all three historical rollups readable while retaining their complete original bodies', () => {
  for (const release of historicalReleases) {
    const notes = releaseNotes(release.body);
    expect(notes.original).toBe(release.body);
    expect(notes.primary).not.toMatch(/[a-f0-9]{40}|Validated source:|## Commits|Merge pull request|Merge branch/);
    if (release.tag === 'v0.1.3') {
      expect(notes.primary).toContain('Consolidate sidebar navigation and clarify agent row hierarchy');
      expect(notes.primary).toContain('Render release notes with reusable safe Markdown');
    } else {
      expect(notes.primary).toContain('## What\'s Changed');
      expect(notes.primary).toContain('https://github.com/swicken/tiller/pull/');
    }
  }
});


it('omits standard plural merge scaffolding only in a recognized generated fallback', () => {
  const subject = "Merge branches 'feature-a' and 'feature-b' into main";
  const body = `${compare}\n\n## Commits\n\n- ${sha} Improve release notes\n- ${'b'.repeat(40)} ${subject}\n\nValidated source: ${sha}\n`;
  const notes = releaseNotes(body);
  expect(notes.primary).toBe(`- Improve release notes\n\n${compare}`);
  expect(notes.original).toBe(body);
  const authored = `## Changes\n\n- ${subject}`;
  expect(releaseNotes(authored)).toEqual({ primary: authored });
});
