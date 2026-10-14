import { useMemo, useState } from 'react';
import type { NodeView } from '../src/shared/protocol';
import { StateDot } from './Bits';
import { cwdBase } from './format';
import { Modal } from './Modal';
import { ancestry } from './sessions';
import { openDialog, selectNode, toggleHistory, useStore } from './store';
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
  const cur = useStore((s) => (s.selected ? s.nodes[s.selected] : undefined));
  const historyOpen = useStore((s) => s.historyOpen);
  const needle = q.toLowerCase();
  const close = () => openDialog(null);
  const nodeHits = all.filter((h) => `${h.n.title} ${h.where}`.toLowerCase().includes(needle))
    .map((h) => ({ key: h.n.id, title: h.n.title, sub: h.where, n: h.n, run: () => { selectNode(h.n.id); close(); } }));
  // Commands follow the nodes; each opens its own view or dialog in place of the palette.
  const cmds = [
    { key: 'cmd:history', title: historyOpen ? 'Hide history' : 'History', sub: 'closed nodes: read, follow up or fork', run: () => { toggleHistory(); close(); } },
    ...(cur?.kind === 'claude' ? [{ key: 'cmd:fork', title: `Fork ${cur.title}…`, sub: 'new node from its conversation', run: () => openDialog({ kind: 'fork', from: cur.id, title: cur.title, cwd: cur.cwd, parentId: cur.parentId }) }] : []),
  ].filter((c) => `${c.title} ${c.sub}`.toLowerCase().includes(needle));
  const hits: Array<{ key: string; title: string; sub: string; n?: NodeView; run: () => void }> = [...nodeHits, ...cmds];
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setI(Math.min(i + 1, hits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI(Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && hits[i]) hits[i].run();
  };
  return (
    <Modal label="Jump to node" className="palette" onClose={close}>
      <input autoFocus placeholder="Jump to a node or run a command…" value={q} onChange={(e) => { setQ(e.target.value); setI(0); }} onKeyDown={onKey} />
      <div className="hits">
        {hits.map((h, j) => (
          <div key={h.key} className={`hit${j === i ? ' active' : ''}`} onMouseMove={() => setI(j)} onClick={h.run}>
            {h.n ? <StateDot kind={statusKind(h.n)} /> : <span className="dot cmd" />}<span className="st">{h.title}</span><span className="sc">{h.sub}</span>
          </div>
        ))}
        {!hits.length && <p className="hint">No matches.</p>}
      </div>
    </Modal>
  );
}
