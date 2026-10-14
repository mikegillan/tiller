import { useState } from 'react';
import { isAgentKind, type ClientMessage, type Harness, type NodeKind, type Role } from '../src/shared/protocol';
import { send } from './conn';
import type { TauriWindow } from './hooks';
import { Modal } from './Modal';
import { expectSpawn, openDialog, useStore, type Dialog } from './store';
import { IN_APP } from './url';

type Spawn = Extract<Dialog, { kind: 'spawn' }>;
const close = () => openDialog(null);

/** The app's native folder dialog (tauri-plugin-dialog): the chosen path, or null when cancelled or not in the app.
 *  It opens at `current` when that is an absolute path, else where the OS chooses. */
const pickFolder = async (current: string): Promise<string | null> => {
  const tauri = (window as TauriWindow).__TAURI_INTERNALS__;
  const defaultPath = current.trim().startsWith('/') ? current.trim() : undefined;
  return ((await tauri?.invoke('plugin:dialog|open', { options: { directory: true, multiple: false, defaultPath, title: 'Choose a working directory' } })) as string | null | undefined) ?? null;
};

type SpawnChoice = 'claude' | 'pi' | 'terminal';

/** The node kind a spawn choice means: a Pi agent, a Claude agent, or a plain terminal. */
const choiceKind = (choice: SpawnChoice): NodeKind => (choice === 'terminal' ? 'terminal' : choice === 'pi' ? 'agent' : 'claude');
/** The harness sent for a choice; omitted for claude and terminal so their records keep the legacy shape. */
const choiceHarness = (choice: SpawnChoice): Harness | undefined => (choice === 'pi' ? 'pi' : undefined);

/** What the spawn dialog sends: kind/harness from the choice, with the agent fields only for agent nodes. */
export function spawnMsg(
  d: { parentId: string | null },
  form: { choice: SpawnChoice; title: string; cwd: string; prompt: string; model: string; role: Role; defaultRole: Role; isolate: boolean },
): ClientMessage {
  const kind = choiceKind(form.choice);
  const agent = isAgentKind(kind);
  const harness = choiceHarness(form.choice);
  return {
    t: 'spawn', kind, ...(harness ? { harness } : {}),
    title: form.title.trim() || form.choice, cwd: form.cwd.trim(), parentId: d.parentId,
    ...(agent && form.prompt.trim() ? { prompt: form.prompt } : {}),
    ...(agent && form.role !== form.defaultRole ? { role: form.role } : {}),
    ...(agent && form.isolate ? { isolation: 'worktree' as const } : {}),
    ...(form.model.trim() ? { model: form.model.trim() } : {}),
  };
}

function SpawnDialog({ d }: { d: Spawn }) {
  const parent = useStore((s) => (d.parentId ? s.nodes[d.parentId] : undefined));
  const [choice, setChoice] = useState<SpawnChoice>(parent?.harness === 'pi' ? 'pi' : 'claude');
  const [title, setTitle] = useState('');
  const [cwd, setCwd] = useState(d.cwd);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const byPosition: Role = d.parentId ? 'worker' : 'orchestrator';
  const [role, setRole] = useState<Role>(byPosition);
  const [isolate, setIsolate] = useState(false);
  const kind = choiceKind(choice);
  const agent = isAgentKind(kind);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    send(spawnMsg(d, { choice, title, cwd, prompt, model, role, defaultRole: byPosition, isolate }));
    expectSpawn();
    close();
  };
  return (
    <Modal title={parent ? `New child of ${parent.title}` : 'New session'} onClose={close}>
      <form className="form" onSubmit={submit}>
        <div className="seg" role="radiogroup" aria-label="Kind">
          {(['claude', 'pi', 'terminal'] as const).map((k) => (
            <button type="button" key={k} role="radio" aria-checked={choice === k} className={choice === k ? 'on' : ''} onClick={() => setChoice(k)}>{k}</button>
          ))}
        </div>
        <label>Title<input placeholder={choice} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
        <label>Working directory<div className="pick">
          <input className="mono" value={cwd} onChange={(e) => setCwd(e.target.value)} required placeholder="/path/to/project" />
          {IN_APP && <button type="button" className="btn" onClick={() => void pickFolder(cwd).then((p) => p && setCwd(p)).catch(() => {})}>Choose…</button>}
        </div></label>
        {agent && <label>Initial prompt<textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Optional" /></label>}
        <label>Model<input className="mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Default" /></label>
        {agent && <label>Role<select value={role} onChange={(e) => setRole(e.target.value as Role)}>{(['orchestrator', 'worker', 'none'] as const).map((r) => <option key={r}>{r}</option>)}</select></label>}
        {agent && (
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

/** What the restart dialog sends; a first prompt is meaningful for an agent node (Claude or Pi). */
export const restartMsg = (id: string, kind: NodeKind, prompt: string): ClientMessage =>
  ({ t: 'restart', id, ...(isAgentKind(kind) && prompt.trim() ? { prompt } : {}) });

function RestartDialog({ id }: { id: string }) {
  const node = useStore((s) => s.nodes[id]);
  const [prompt, setPrompt] = useState('');
  if (!node) return null;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    send(restartMsg(id, node.kind, prompt));
    close();
  };
  return (
    <Modal title={`Restart ${node.title}?`} onClose={close}>
      <form className="form" onSubmit={submit}>
        <p>Its context is cleared; children are kept.</p>
        {isAgentKind(node.kind) && <label>First prompt<textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Optional: by default it is pointed at its handoff.md, if there is one" /></label>}
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
