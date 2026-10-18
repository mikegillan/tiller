import { useId, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { IN_APP } from './url';
import { openExternalUrl } from './externalLink';
import './markdown.css';

/** Render untrusted Markdown without HTML or automatic remote image requests. */
export function Markdown({ children }: { children: string }) {
  const [linkError, setLinkError] = useState(false);
  const footnotePrefix = `markdown-${useId()}-`;
  const footnoteLabel = `${footnotePrefix}footnote-label`;
  return <div className="markdown">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      remarkRehypeOptions={{ clobberPrefix: footnotePrefix }}
      skipHtml
      urlTransform={(url) => /^(https?:\/\/|#)/i.test(url) ? url : ''}
      components={{
        a: ({ node: _node, href, children, ...props }) => href
          ? <a {...props} aria-describedby={props['aria-describedby'] === 'footnote-label' ? footnoteLabel : props['aria-describedby']} href={href} target={href.startsWith('#') ? undefined : '_blank'} rel={href.startsWith('#') ? undefined : 'noopener noreferrer'} onClick={IN_APP && !href.startsWith('#') ? (event) => {
            event.preventDefault();
            setLinkError(false);
            void openExternalUrl(href).catch(() => setLinkError(true));
          } : undefined}>{children}</a>
          : <span>{children}</span>,
        // remark-rehype prefixes references/definitions, but its label ID is fixed.
        h2: ({ node: _node, id, ...props }) => <h2 {...props} id={id === 'footnote-label' ? footnoteLabel : id} />,
        img: ({ alt }) => <span>{alt}</span>,
        table: ({ children }) => <div className="markdown-table" tabIndex={0} role="region" aria-label="Table"><table>{children}</table></div>,
      }}
    >{children}</ReactMarkdown>
    {linkError && <p role="alert">Could not open the link. Try again or copy the link address into your browser.</p>}
  </div>;
}
