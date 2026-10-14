import { useState } from 'react';
import type { ClientMessage, NodeKind, Role } from '../src/shared/protocol';
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
  const byPosition: Role = d.parentId ? 'worker' : 'orchestrator';
  const [role, setRole] = useState<Role>(byPosition);
  const [isolate, setIsolate] = useState(false);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    send({
      t: 'spawn', kind, title: title.trim() || kind, cwd: cwd.trim(), parentId: d.parentId,
      ...(kind === 'claude' && prompt.trim() ? { prompt } : {}),
      ...(kind === 'claude' && role !== byPosition ? { role } : {}),
      ...(kind === 'claude' && isolate ? { isolation: 'worktree' as const } : {}),
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
        {kind === 'claude' && <label>Role<select value={role} onChange={(e) => setRole(e.target.value as Role)}>{(['orchestrator', 'worker', 'none'] as const).map((r) => <option key={r}>{r}</option>)}</select></label>}
        {kind === 'claude' && (
          <label className="check"><input type="checkbox" checked={isolate} onChange={(e) => setIsolate(e.target.checked)} />Isolate in a git worktree
            <small>Its branch is created from the current checkout's HEAD.</small></label>
        )}
        <div className="btns"><button type="button" className="btn" onClick={close}>Cancel</button><button type="submit" className="btn primary">Spawn</button></div>
      </form>
    </Modal>
  );
}

/** The close choices for a node with a worktree; plain Close sends no worktree option, so the daemon refuses a dirty or unmerged tree. */
export const worktreeCloses = (id: string): Array<{ label: string; className: string; msg: ClientMessage }> => [
  { label: 'Close', className: 'btn primary', msg: { t: 'close', id } },
  { label: 'Keep branch', className: 'btn', msg: { t: 'close', id, worktree: 'keep' } },
  { label: 'Discard', className: 'btn danger solid', msg: { t: 'close', id, worktree: 'discard' } },
];

function KillDialog({ id }: { id: string }) {
  const node = useStore((s) => s.nodes[id]);
  if (!node) return null;
  const wt = node.worktree;
  if (wt) return (
    <Modal title={`Close ${node.title}?`} onClose={close}>
      <p>It works in its own git worktree on branch <code>{wt.branch}</code>. Close stops it and removes the worktree only when the tree is clean and merged into {wt.base}; otherwise the close is refused and the node keeps running.</p>
      <p>Keep branch commits uncommitted work as a WIP commit, removes the directory and keeps the branch. Discard deletes the worktree and the branch, including uncommitted work.</p>
      <div className="btns">
        <button className="btn" autoFocus onClick={close}>Cancel</button>
        {worktreeCloses(id).map((c) => <button key={c.label} className={c.className} onClick={() => { send(c.msg); close(); }}>{c.label}</button>)}
      </div>
    </Modal>
  );
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

function RestartDialog({ id }: { id: string }) {
  const node = useStore((s) => s.nodes[id]);
  const [prompt, setPrompt] = useState('');
  if (!node) return null;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    send({ t: 'restart', id, ...(node.kind === 'claude' && prompt.trim() ? { prompt } : {}) });
    close();
  };
  return (
    <Modal title={`Restart ${node.title}?`} onClose={close}>
      <form className="form" onSubmit={submit}>
        <p>Its context is cleared; children are kept.</p>
        {node.kind === 'claude' && <label>First prompt<textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Optional: by default it is pointed at its handoff.md, if there is one" /></label>}
        <div className="btns">
          <button type="button" className="btn" autoFocus onClick={close}>Cancel</button>
          <button type="submit" className="btn primary">Restart</button>
        </div>
      </form>
    </Modal>
  );
}

type Fork = Extract<Dialog, { kind: 'fork' }>;

/** What the follow-up dialog sends: the archived node's session continues as a new live node. */
export const followupMsg = (id: string, prompt: string): ClientMessage => ({ t: 'followup', id, prompt });

/** What the fork dialog sends: a Claude node in the source's directory that starts from its conversation. */
export const forkMsg = (d: Fork, title: string, prompt: string): ClientMessage => ({
  t: 'spawn', kind: 'claude', title: title.trim() || `fork of ${d.title}`, cwd: d.cwd, parentId: d.parentId, fork: d.from,
  ...(prompt.trim() ? { prompt } : {}),
});

function FollowupDialog({ id, title }: { id: string; title: string }) {
  const [prompt, setPrompt] = useState('');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    send(followupMsg(id, prompt));
    expectSpawn();
    close();
  };
  return (
    <Modal title={`Follow up on ${title}`} onClose={close}>
      <form className="form" onSubmit={submit}>
        <p>Its last session continues as a new node, starting on this prompt.</p>
        <label>Prompt<textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} required autoFocus /></label>
        <div className="btns"><button type="button" className="btn" onClick={close}>Cancel</button><button type="submit" className="btn primary" disabled={!prompt.trim()}>Follow up</button></div>
      </form>
    </Modal>
  );
}

function ForkDialog({ d }: { d: Fork }) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    send(forkMsg(d, title, prompt));
    expectSpawn();
    close();
  };
  return (
    <Modal title={`Fork ${d.title}`} onClose={close}>
      <form className="form" onSubmit={submit}>
        <p>A new Claude node in <code>{d.cwd}</code> starts with a copy of this conversation; the original is not changed.</p>
        <label>Title<input placeholder={`fork of ${d.title}`} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
        <label>Prompt<textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Optional" /></label>
        <div className="btns"><button type="button" className="btn" onClick={close}>Cancel</button><button type="submit" className="btn primary">Fork</button></div>
      </form>
    </Modal>
  );
}

export function Dialogs() {
  const d = useStore((s) => s.dialog);
  if (d?.kind === 'spawn') return <SpawnDialog d={d} />;
  if (d?.kind === 'kill') return <KillDialog id={d.id} />;
  if (d?.kind === 'restart') return <RestartDialog id={d.id} />;
  if (d?.kind === 'followup') return <FollowupDialog id={d.id} title={d.title} />;
  if (d?.kind === 'fork') return <ForkDialog d={d} />;
  return null;
}
