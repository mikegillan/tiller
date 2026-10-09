import { useEffect, useRef } from 'react';
import { send } from './conn';
import { useStore } from './store';
import { createTerm, disposeTerm, getTerm as getT } from './terminals';
import '@xterm/xterm/css/xterm.css';

function TermView({ id, visible }: { id: string; visible: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const connected = useStore((s) => s.connected);

  useEffect(() => {
    const { term } = createTerm(id, el.current!);
    const sub = term.onData((data) => send({ t: 'input', id, data }));
    return () => { sub.dispose(); disposeTerm(id); };
  }, [id]);

  // Becoming visible (or reconnecting while visible): clear, fit, attach so the daemon replays scrollback.
  useEffect(() => {
    if (!visible || !connected) return;
    const t = getT(id);
    if (!t) return;
    t.term.clear();
    t.fit.fit();
    send({ t: 'select', id });
    send({ t: 'attach', id, cols: t.term.cols, rows: t.term.rows });
    t.term.focus();
    return () => send({ t: 'detach', id });
  }, [id, visible, connected]);

  useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const t = getT(id);
        if (!t) return;
        t.fit.fit();
        send({ t: 'resize', id, cols: t.term.cols, rows: t.term.rows });
      }, 100);
    });
    ro.observe(el.current!);
    return () => { clearTimeout(timer); ro.disconnect(); };
  }, [id, visible]);

  return <div ref={el} className={`term${visible ? ' show' : ''}`} />;
}

export function TerminalPane() {
  const opened = useStore((s) => s.opened);
  const selected = useStore((s) => s.selected);
  return (
    <div className="termwrap">
      {opened.map((id) => <TermView key={id} id={id} visible={id === selected} />)}
    </div>
  );
}
