import { useState } from 'react';
import { selectNode } from './store';
import type { Row } from './tree';

export function Palette({ rows, onClose }: { rows: Row[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  // Search all nodes, including those under collapsed parents: rows only lists visible ones, so add descendants.
  const nodes = rows.flatMap((r) => [r.node, ...(r.collapsed ? r.descendants : [])]);
  const hits = nodes.filter((n) => n.title.toLowerCase().includes(q.toLowerCase()));
  const pick = (id: string) => { selectNode(id); onClose(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') { e.preventDefault(); setI(Math.min(i + 1, hits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI(Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && hits[i]) pick(hits[i].id);
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input autoFocus placeholder="Jump to node..." value={q} onChange={(e) => { setQ(e.target.value); setI(0); }} onKeyDown={onKey} />
        {hits.map((n, j) => (
          <div key={n.id} className={`hit${j === i ? ' active' : ''}`} onClick={() => pick(n.id)}>{n.title}</div>
        ))}
      </div>
    </div>
  );
}
