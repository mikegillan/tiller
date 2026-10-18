import { Markdown } from '../controls/Markdown';
import { releaseNotes } from './parseReleaseNotes';
import './releaseNotes.css';

export function ReleaseNotes({ body }: { body: string }) {
  const notes = releaseNotes(body);
  return <>
    <Markdown>{notes.primary}</Markdown>
    {notes.original && <details className="release-technical">
      <summary>Technical details</summary>
      <pre aria-label="Original release notes">{notes.original}</pre>
    </details>}
  </>;
}
