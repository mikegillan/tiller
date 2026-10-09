import { useState } from 'react';
import type { NodeKind } from '../src/shared/protocol';
import { send } from './conn';
import { Modal } from './Modal';
import { expectSpawn, openDialog, useStore, type Dialog } from './store';

type Spawn = Extract<Dialog, { kind: 'spawn' }>;
const close = () => openDialog(null);

function SpawnDialog({ d }: { d: Spawn }) {
  const parent = useStore((s) => (d.parentId ? s.nodes[d.parentId] : undefined));
  const [kind, setKind] = useState<NodeKind>('claude');
  const [title, setTitle] = useState('');
  const [cwd, setCwd] = useState(d.cwd);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    send({
      t: 'spawn', kind, title: title.trim() || kind, cwd: cwd.trim(), parentId: d.parentId,
      ...(kind === 'claude' && prompt.trim() ? { prompt } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
    });
    expectSpawn();
    close();
  };
  return (
    <Modal title={parent ? `New child of ${parent.title}` : 'New session'} onClose={close}>
      <form className="form" onSubmit={submit}>
        <div className="seg" role="radiogroup" aria-label="Kind">
          {(['claude', 'terminal'] as const).map((k) => (
            <button type="button" key={k} role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{k}</button>
          ))}
        </div>
        <label>Title<input placeholder={kind} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
        <label>Working directory<input className="mono" value={cwd} onChange={(e) => setCwd(e.target.value)} required placeholder="/path/to/project" /></label>
        {kind === 'claude' && <label>Initial prompt<textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Optional" /></label>}
        <label>Model<input className="mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Default" /></label>
        <div className="btns"><button type="button" className="btn" onClick={close}>Cancel</button><button type="submit" className="btn primary">Spawn</button></div>
      </form>
    </Modal>
  );
}

function KillDialog({ id }: { id: string }) {
  const node = useStore((s) => s.nodes[id]);
  if (!node) return null;
  return (
    <Modal title={`Kill ${node.title}?`} onClose={close}>
      <p>The process is stopped and the node is closed. Any work it has not finished is lost.</p>
      <div className="btns">
        <button className="btn" autoFocus onClick={close}>Cancel</button>
        <button className="btn danger solid" onClick={() => { send({ t: 'close', id }); close(); }}>Kill</button>
      </div>
    </Modal>
  );
}

export function Dialogs() {
  const d = useStore((s) => s.dialog);
  if (d?.kind === 'spawn') return <SpawnDialog d={d} />;
  if (d?.kind === 'kill') return <KillDialog id={d.id} />;
  return null;
}
