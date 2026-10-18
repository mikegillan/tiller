import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { IN_APP } from './url';
import { openExternalUrl } from './externalLink';
import './markdown.css';

/** Render untrusted Markdown without HTML or automatic remote image requests. */
export function Markdown({ children }: { children: string }) {
  const [linkError, setLinkError] = useState(false);
  return <div className="markdown">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={(url) => /^(https?:\/\/|#)/i.test(url) ? url : ''}
      components={{
        a: ({ node: _node, href, children, ...props }) => href
          ? <a {...props} href={href} target={href.startsWith('#') ? undefined : '_blank'} rel={href.startsWith('#') ? undefined : 'noopener noreferrer'} onClick={IN_APP && !href.startsWith('#') ? (event) => {
            event.preventDefault();
            setLinkError(false);
            void openExternalUrl(href).catch(() => setLinkError(true));
          } : undefined}>{children}</a>
          : <span>{children}</span>,
        img: ({ alt }) => <span>{alt}</span>,
        table: ({ children }) => <div className="markdown-table" tabIndex={0} role="region" aria-label="Table"><table>{children}</table></div>,
      }}
    >{children}</ReactMarkdown>
    {linkError && <p role="alert">Could not open the link. Try again or copy the link address into your browser.</p>}
  </div>;
}
