import { useState } from 'react';
import type { Outcome } from '../../src/shared/protocol';

/** Text past this many characters or lines is clamped until expanded. */
const LONG_CHARS = 600, LONG_LINES = 10;

/** Time of day for today, else the date as well. */
export function fmtWhen(at: number, now = Date.now()): string {
  const d = new Date(at);
  return d.toDateString() === new Date(now).toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const When = ({ at }: { at: number }) => <time dateTime={new Date(at).toISOString()}>{fmtWhen(at)}</time>;

/** Plain text, clamped with Show more when long. */
export function ClampedText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_CHARS || text.split('\n').length > LONG_LINES;
  return (
    <>
      <div className={`text${long && !open ? ' clamped' : ''}`}>{text}</div>
      {long && <button className="more" onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show more'}</button>}
    </>
  );
}

export const Tools = ({ tools }: { tools?: string[] }) =>
  tools?.length ? <div className="tools">{tools.map((t, i) => <span className="chip" key={i}>{t}</span>)}</div> : null;

const GLYPH = { succeeded: '✓', failed: '✗' } as const; // slop-ok: outcome marks, not emoji
export const OutcomeGlyph = ({ o }: { o?: Outcome['outcome'] }) => (
  <span className={`glyph ${o ?? 'none'}`} title={o ?? 'no outcome reported'}>{o ? GLYPH[o] : '·'}</span>
);
