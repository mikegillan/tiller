import { useEffect, useState } from 'react';
import type { Row } from './tree';
import { NodeRow } from './NodeRow';
import { SpawnForm } from './SpawnForm';

export function Sidebar({ rows }: { rows: Row[] }) {
  const [now, setNow] = useState(Date.now());
  const [form, setForm] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <aside className="sidebar">
      <div className="rows">
        {rows.map((r) => <NodeRow key={r.node.id} row={r} now={now} />)}
      </div>
      {form && <SpawnForm onClose={() => setForm(false)} />}
      <button className="new" onClick={() => setForm((f) => !f)}>+ New node</button>
    </aside>
  );
}
