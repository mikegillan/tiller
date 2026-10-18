import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './Markdown';

const render = (source: string) => renderToStaticMarkup(<Markdown>{source}</Markdown>);

it('renders release-note structure, emphasis, links and code without rewriting the source', () => {
  const source = '## Changes\n\nA **bold** and *small* improvement with `tl update`.\n\n- Fix reconnect\n- Keep sessions\n\n1. Check\n2. Restart\n\n```sh\ntl update --check\n```\n\n**Full Changelog**: https://github.com/example/tiller/compare/v1...v2';
  const html = render(source);
  expect(html).toContain('<h2>Changes</h2>');
  expect(html).toContain('<p>A <strong>bold</strong> and <em>small</em> improvement with <code>tl update</code>.</p>');
  expect(html).toContain('<ul>\n<li>Fix reconnect</li>\n<li>Keep sessions</li>\n</ul>');
  expect(html).toContain('<ol>\n<li>Check</li>\n<li>Restart</li>\n</ol>');
  expect(html).toContain('<pre><code class="language-sh">tl update --check\n</code></pre>');
  expect(html).toContain('<strong>Full Changelog</strong>: <a href="https://github.com/example/tiller/compare/v1...v2" target="_blank" rel="noopener noreferrer">');
});

it('supports GFM tables, task lists, strikethrough and autolinks', () => {
  const html = render('| Change | Status |\n| --- | --- |\n| Reconnect | Ready |\n\n- [x] Shipped\n\n~~Old~~ www.example.com');
  expect(html).toContain('role="region" aria-label="Table"');
  expect(html).toContain('<table>');
  expect(html).toContain('<th>Change</th>');
  expect(html).toContain('<td>Ready</td>');
  expect(html).toContain('type="checkbox" disabled="" checked=""');
  expect(html).toContain('<del>Old</del>');
  expect(html).toContain('href="http://www.example.com"');
});

it('never renders raw HTML, scripts or remote images from untrusted content', () => {
  const html = render('Before <img src="https://tracker.example/pixel" onerror="alert(1)"> after\n\n<script>alert(1)</script>\n\n<iframe src="https://example.com"></iframe>\n\n![Diagram](https://tracker.example/pixel)\n\n`<script>literal</script>`');
  expect(html).toContain('Before  after');
  expect(html).toContain('<span>Diagram</span>');
  expect(html).toContain('&lt;script&gt;literal&lt;/script&gt;');
  for (const unsafe of ['<script', '<iframe', '<img', 'onerror', 'tracker.example', 'alert(1)']) expect(html).not.toContain(unsafe);
});

it.each(['javascript:alert%281%29', 'JaVaScRiPt:alert%281%29', 'jav&#x61;script:alert%281%29', 'vbscript:msgbox%281%29', 'data:text/html,hello', 'file:///etc/passwd', 'tel:123', 'mailto:a@example.com', '//evil.example', '/?k=other', '../settings'])('does not make unsafe or app-relative URLs clickable: %s', (url) => {
  expect(render(`[Unsafe](${url})`)).toBe('<div class="markdown"><p><span>Unsafe</span></p></div>');
});

it('keeps safe web links separate from the app and fragment links within the document', () => {
  const html = render('[Web](https://example.com "Details") [Local](#note)');
  expect(html).toContain('<a title="Details" href="https://example.com" target="_blank" rel="noopener noreferrer">Web</a>');
  expect(html).toContain('<a href="#note">Local</a>');
});

it('preserves accessible footnote references and backlinks', () => {
  const html = render('A detail[^1].\n\n[^1]: More context.');
  expect(html).toContain('aria-describedby="footnote-label"');
  expect(html).toContain('aria-label="Back to reference 1"');
});
