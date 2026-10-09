import { useState } from 'react';
import type { NodeKind } from '../src/shared/protocol';
import { send } from './conn';

export function SpawnForm({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<NodeKind>('claude');
  const [title, setTitle] = useState('');
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    send({
      t: 'spawn', kind, title: title.trim() || kind, cwd: cwd.trim(),
      ...(kind === 'claude' && prompt ? { prompt } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
    });
    onClose();
  };
  return (
    <form className="spawn" onSubmit={submit}>
      <select value={kind} onChange={(e) => setKind(e.target.value as NodeKind)}>
        <option value="claude">claude</option>
        <option value="terminal">terminal</option>
      </select>
      <input placeholder="title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      <input placeholder="cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} required />
      {kind === 'claude' && <textarea placeholder="prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />}
      <input placeholder="model (optional)" value={model} onChange={(e) => setModel(e.target.value)} />
      <div className="btns"><button type="submit">Spawn</button><button type="button" onClick={onClose}>Cancel</button></div>
    </form>
  );
}
