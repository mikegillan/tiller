import { useEffect, useRef } from 'react';
import { send } from './conn';
import { useStore } from './store';
import { createTerm, disposeTerm, getTerm } from './terminals';
import '@xterm/xterm/css/xterm.css';

function TermView({ id, visible, exited }: { id: string; visible: boolean; exited: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const connected = useStore((s) => s.connected);

  useEffect(() => {
    const { term } = createTerm(id, el.current!);
    const sub = term.onData((data) => send({ t: 'input', id, data }));
    // Legacy mouse reports contain raw bytes, including after a serialized screen attach.
    const binarySub = term.onBinary((data) => send({ t: 'input', id, data, binary: true }));
    return () => { sub.dispose(); binarySub.dispose(); disposeTerm(id); };
  }, [id]);

  // Becoming visible (or reconnecting / resuming while visible): reset, fit, attach. The reply is a serialized screen to write as-is.
  useEffect(() => {
    if (!visible || !connected) return;
    const t = getTerm(id);
    if (!t) return;
    t.term.reset();
    t.fit.fit();
    send({ t: 'select', id });
    send({ t: 'attach', id, cols: t.term.cols, rows: t.term.rows });
    if (!exited && !document.activeElement?.closest('.tree')) t.term.focus();
    return () => send({ t: 'detach', id });
  }, [id, visible, connected, exited]);

  useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const t = getTerm(id);
        if (!t) return;
        t.fit.fit();
        send({ t: 'resize', id, cols: t.term.cols, rows: t.term.rows });
      }, 100);
    });
    ro.observe(el.current!);
    return () => { clearTimeout(timer); ro.disconnect(); };
  }, [id, visible]);

  // visibility, never display:none: a hidden xterm cannot measure itself.
  return <div ref={el} className={`term${visible ? ' show' : ''}`} />;
}

export function TerminalPane() {
  const opened = useStore((s) => s.opened);
  const selected = useStore((s) => s.selected);
  const nodes = useStore((s) => s.nodes);
  return (
    <div className="termwrap">
      {opened.map((id) => <TermView key={id} id={id} visible={id === selected} exited={!!nodes[id]?.status.exited} />)}
    </div>
  );
}
