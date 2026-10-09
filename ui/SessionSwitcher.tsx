import { useEffect, useMemo, useRef, useState } from 'react';
import { StateDot } from './Bits';
import { cwdBase } from './format';
import { Icon } from './icons';
import { openDialog, selectSession, useStore } from './store';
import { sessions, type SessionInfo } from './sessions';

function Item({ s, current, onPick }: { s: SessionInfo; current: boolean; onPick: () => void }) {
  return (
    <button className={`sess${current ? ' cur' : ''}`} role="option" aria-selected={current} onClick={onPick}>
      <StateDot kind={s.kind} />
      <span className="st">{s.root.title}</span>
      <span className="sc">{cwdBase(s.root.cwd)}</span>
      {s.needs > 0 && <span className="count warn">{s.needs}</span>}
    </button>
  );
}

export function SessionSwitcher() {
  const nodes = useStore((s) => s.nodes);
  const order = useStore((s) => s.order);
  const session = useStore((s) => s.session);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const list = useMemo(() => sessions(nodes, order), [nodes, order]);
  const cur = list.find((s) => s.root.id === session);
  const others = list.filter((s) => s !== cur && s.needs > 0).reduce((a, s) => a + s.needs, 0);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('mousedown', away);
    addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', away); removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div className="switcher" ref={box}>
      <button className="current" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        {cur ? <><StateDot kind={cur.kind} /><span className="st">{cur.root.title}</span><span className="sc">{cwdBase(cur.root.cwd)}</span></> : <span className="sc">No session</span>}
        {(cur?.needs ?? 0) > 0 && <span className="count warn">{cur!.needs}</span>}
        {others > 0 && <span className="count warn" title="needs you in other sessions">+{others}</span>}
        <Icon name="updown" size={14} />
      </button>
      {open && (
        <div className="menu" role="listbox">
          {list.map((s) => <Item key={s.root.id} s={s} current={s === cur} onPick={() => { selectSession(s.root.id); setOpen(false); }} />)}
          <button className="sess new" onClick={() => { setOpen(false); openDialog({ kind: 'spawn', parentId: null, cwd: cur?.root.cwd ?? '' }); }}>
            <Icon name="plus" size={14} /><span className="st">New session here…</span>
          </button>
        </div>
      )}
    </div>
  );
}
