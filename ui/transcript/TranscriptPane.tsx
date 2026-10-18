import { Select } from '../controls/Select';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Harness, Transcript, TranscriptEntry } from '../../src/shared/protocol';
import { send } from '../conn';
import { transcriptRequested, useStore } from '../store';

/** Text past this many characters or lines is clamped until expanded. */
const LONG_CHARS = 600, LONG_LINES = 10;

/** Time of day for today, else the date as well. */
export function fmtWhen(at: number, now = Date.now()): string {
  const d = new Date(at);
  return d.toDateString() === new Date(now).toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function Entry({ e, assistantName }: { e: TranscriptEntry; assistantName: string }) {
  const [open, setOpen] = useState(false);
  const long = e.text.length > LONG_CHARS || e.text.split('\n').length > LONG_LINES;
  return (
    <article className={`entry ${e.role}`}>
      <header>
        <span className="who">{e.role === 'user' ? 'User' : assistantName}</span>
        {e.at !== undefined && <time dateTime={new Date(e.at).toISOString()}>{fmtWhen(e.at)}</time>}
      </header>
      {e.text && <div className={`text${long && !open ? ' clamped' : ''}`}>{e.text}</div>}
      {long && <button className="more" onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show more'}</button>}
      {!!e.tools?.length && <div className="tools">{e.tools.map((t, i) => <span className="chip" key={i}>{t}</span>)}</div>}
    </article>
  );
}

/** A conversation as a timeline; a session picker (current first) when there is more than one session. `sessionId` undefined is the current one. */
export function TranscriptView({ data, sessionId, onSession, harness = 'claude' }: { data: Transcript; sessionId?: string; onSession: (id: string | undefined) => void; harness?: Harness }) {
  const assistantName = harness === 'codex' ? 'Codex' : harness === 'pi' ? 'Pi' : 'Claude';
  return (
    <>
      {data.sessions.length > 1 && (
        <label className="sesspick">Session
          <Select value={sessionId ?? ''} onChange={(e) => onSession(e.target.value || undefined)}>
            {data.sessions.map((s) => <option key={s.sessionId} value={s.current ? '' : s.sessionId}>{s.current ? 'Current session' : `Session ${s.sessionId.slice(0, 8)}`}</option>)}
          </Select>
        </label>
      )}
      {data.truncated && <p className="hint">Older messages are not shown.</p>}
      {data.entries.map((e, i) => <Entry key={i} e={e} assistantName={assistantName} />)}
      {!data.entries.length && <p className="hint">No messages in this session.</p>}
    </>
  );
}

/**
 * A live or archived node's conversation over the stage; `children` go above it. Asks on open, on reconnect, on a session
 * change and whenever `refresh` changes. Key it by node id so the session choice resets.
 */
export function TranscriptPane({ id, refresh, harness, children }: { id: string; refresh?: unknown; harness?: Harness; children?: ReactNode }) {
  const [sessionId, setSessionId] = useState<string>();
  const t = useStore((s) => (s.transcript?.id === id && s.transcript.sessionId === sessionId ? s.transcript : undefined));
  const connected = useStore((s) => s.connected);
  const scroller = useRef<HTMLDivElement>(null);
  const scrolled = useRef<string | undefined>(undefined); // the session already scrolled to its newest entry

  useEffect(() => {
    if (!connected) return;
    transcriptRequested(id, sessionId);
    send({ t: 'transcript', id, ...(sessionId && { sessionId }) });
  }, [id, sessionId, connected, refresh]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!t?.data || !el || scrolled.current === (sessionId ?? '')) return;
    scrolled.current = sessionId ?? '';
    el.scrollTop = el.scrollHeight;
  }, [t?.data, sessionId]);

  return (
    <div className="transcript" ref={scroller}>
      {children}
      <div className="entries">
        {t?.error ? <p className="hint">{t.error}</p>
          : !t?.data ? <p className="hint">Loading transcript…</p>
          : <TranscriptView data={t.data} sessionId={sessionId} onSession={setSessionId} harness={harness} />}
      </div>
    </div>
  );
}
