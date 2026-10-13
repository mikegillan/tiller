import { useMemo, useState } from 'react';
import { StateDot } from './Bits';
import { cwdBase } from './format';
import { Modal } from './Modal';
import { ancestry } from './sessions';
import { openDialog, selectNode, useStore } from './store';
import { statusKind } from './tree';

export function Palette() {
  const nodes = useStore((s) => s.nodes);
  const order = useStore((s) => s.order);
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const all = useMemo(() => order.map((id) => nodes[id]).filter(Boolean).map((n) => {
    const root = ancestry(nodes, n.id)[0] ?? n;
    return { n, where: root === n ? cwdBase(n.cwd) : `${root.title} · ${cwdBase(n.cwd)}` };
  }), [nodes, order]);
  const needle = q.toLowerCase();
  const hits = all.filter((h) => `${h.n.title} ${h.where}`.toLowerCase().includes(needle));
  const close = () => openDialog(null);
  const pick = (id: string) => { selectNode(id); close(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setI(Math.min(i + 1, hits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI(Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && hits[i]) pick(hits[i].n.id);
  };
  return (
    <Modal label="Jump to node" className="palette" onClose={close}>
      <input autoFocus placeholder="Jump to a node…" value={q} onChange={(e) => { setQ(e.target.value); setI(0); }} onKeyDown={onKey} />
      <div className="hits">
        {hits.map((h, j) => (
          <div key={h.n.id} className={`hit${j === i ? ' active' : ''}`} onMouseMove={() => setI(j)} onClick={() => pick(h.n.id)}>
            <StateDot kind={statusKind(h.n)} /><span className="st">{h.n.title}</span><span className="sc">{h.where}</span>
          </div>
        ))}
        {!hits.length && <p className="hint">No matches.</p>}
      </div>
    </Modal>
  );
}
