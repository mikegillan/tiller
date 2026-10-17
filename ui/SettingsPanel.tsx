import { useEffect, useRef, useState } from 'react';
import { token } from './url';
import { buildChanges, codexRecommendations, efforts, formatValue, groups, inputValue, profileFields, type Field, type Scope, type SettingsSnapshot } from './settings-model';
import './settings.css';

async function request(scope: Scope, nodeId: string | undefined, body?: unknown, signal?: AbortSignal): Promise<SettingsSnapshot> {
  const query = new URLSearchParams({ scope, ...(nodeId ? { nodeId } : {}) });
  const response = await fetch(`/api/settings?${query}`, {
    method: body ? 'POST' : 'GET', signal,
    headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(typeof data.error === 'string' ? data.error : `Settings request failed (${response.status}).`), { conflict: response.status === 409 });
  if (!data || data.scope !== scope || typeof data.path !== 'string' || typeof data.revision !== 'string' || !data.values || !data.entries || !data.inherited) throw new Error('The server returned an invalid settings snapshot.');
  return data;
}

export function SettingsPanel({ nodeId, onClose }: { nodeId?: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [scope, setScope] = useState<Scope>(nodeId ? 'project' : 'home');
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>();
  const [drafts, setDrafts] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [conflict, setConflict] = useState(false);
  const [discard, setDiscard] = useState<Scope | 'close' | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const [reload, setReload] = useState(0);
  const dirty = Object.keys(drafts).length > 0;
  const sections = [
    ...Object.keys(efforts).map((harness) => ({ title: `${harness} task profiles`, help: 'Unset model and effort preserve inherited or harness defaults. Model IDs are passed through to the harness.', fields: profileFields(harness as keyof typeof efforts) })),
    ...groups.filter((group) => !group.homeOnly || scope === 'home'),
  ];
  const fields = sections.flatMap((group) => group.fields);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(undefined); setBusy(true); setError(''); setSuccess(''); setConflict(false); setDrafts({});
    request(scope, scope === 'project' ? nodeId : undefined, undefined, controller.signal).then(setSnapshot).catch((err) => { if (!controller.signal.aborted) setError(err.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [scope, nodeId, reload]);
  useEffect(() => { if (error || success || discard) content.current?.scrollTo({ top: 0 }); }, [error, success, discard]);
  const leave = (target: Scope | 'close') => {
    if (busy) return;
    if (dirty) { setDiscard(target); return; }
    if (target === 'close') onClose(); else setScope(target);
  };
  const edit = (key: string, raw: string | null) => { setDrafts((d) => ({ ...d, [key]: raw })); setSuccess(''); setError(''); };
  async function save() {
    if (!snapshot || busy) return;
    let changes: Record<string, unknown | null>;
    try { changes = buildChanges(snapshot, drafts, fields); } catch (err) { setError((err as Error).message); return; }
    if (!Object.keys(changes).length) { setDrafts({}); setSuccess('No changes to save.'); return; }
    setBusy(true); setError(''); setSuccess('');
    try {
      setSnapshot(await request(scope, scope === 'project' ? nodeId : undefined, { scope, ...(scope === 'project' ? { nodeId } : {}), revision: snapshot.revision, changes }));
      setDrafts({}); setSuccess('Settings saved. New defaults apply on their next use.'); setConflict(false);
    } catch (err) { setError((err as Error).message); setConflict(!!(err as { conflict?: boolean }).conflict); }
    finally { setBusy(false); }
  }
  function renderField(field: Field) {
    if (!snapshot) return null;
    const { key, label } = field;
    const drafted = Object.hasOwn(drafts, key);
    const explicit = drafted ? drafts[key] !== null : Object.hasOwn(snapshot.values, key);
    const fallback = snapshot.inherited[key];
    const entry = snapshot.entries[key];
    const raw = drafted && drafts[key] !== null ? drafts[key]! : inputValue(explicit ? snapshot.values[key] : fallback?.value, field);
    const id = `setting-${key}`;
    const props = { id, disabled: busy || !explicit, value: raw, 'aria-describedby': `${id}-help`, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => edit(key, e.target.value) };
    return <div className="settings-field" key={key}>
      <label htmlFor={id}>{label}</label>
      <div className="settings-control">
        {field.options || field.kind === 'boolean' ? <select {...props}>
          {!raw && <option value="">Harness default / unset</option>}
          {field.options && raw && !field.options.includes(raw) && <option value={raw}>{raw} (current)</option>}
          {(field.options ?? ['true', 'false']).map((option) => <option key={option} value={option}>{option}</option>)}
        </select> : field.kind === 'list' ? <textarea {...props} rows={3} /> : <input {...props} type={field.kind === 'number' ? 'number' : 'text'} step="any" />}
        <button className="btn" type="button" disabled={busy} onClick={() => edit(key, explicit ? null : inputValue(fallback?.value ?? (field.kind === 'boolean' ? false : ''), field))}>{explicit ? 'Reset to inherit' : 'Set here'}</button>
      </div>
      <div className="settings-detail" id={`${id}-help`}>
        {field.help && <div>{field.help}</div>}
        <div><span>Effective: </span><code>{formatValue(entry?.value)}</code><span> · from </span><code>{entry?.source ?? 'default'}</code></div>
        {drafted && <div className="settings-pending">{drafts[key] === null ? `After save: inherit ${formatValue(fallback?.value)} from ${fallback?.source ?? 'default'}` : 'Local change pending save'}</div>}
      </div>
    </div>;
  }
  return <dialog className="settings-dialog" ref={dialog} aria-labelledby="settings-title" onCancel={(event) => { event.preventDefault(); leave('close'); }} onKeyDown={(event) => event.stopPropagation()}>
    <header className="settings-header"><h2 id="settings-title">Settings</h2><button className="btn" disabled={busy} onClick={() => leave('close')}>Close</button></header>
    <div className="settings-scope" role="group" aria-label="Settings scope">
      <button className={`btn${scope === 'project' ? ' primary' : ''}`} aria-pressed={scope === 'project'} disabled={!nodeId || busy} onClick={() => leave('project')}>Selected project</button>
      <button className={`btn${scope === 'home' ? ' primary' : ''}`} aria-pressed={scope === 'home'} disabled={busy} onClick={() => leave('home')}>Global home</button>
      {!nodeId && <span>Select a node to edit its project settings.</span>}
    </div>
    <p className="settings-path">{snapshot ? <>Editing <code>{snapshot.path}</code></> : 'Loading target…'}</p>
    <div className="settings-content" ref={content} aria-busy={busy}>
      {discard && <div className="settings-notice" role="alert"><p>Discard unsaved changes?</p><button className="btn" onClick={() => setDiscard(null)}>Keep editing</button>{' '}<button className="btn danger" onClick={() => { const target = discard; setDiscard(null); setDrafts({}); if (target === 'close') onClose(); else setScope(target); }}>Discard changes</button></div>}
      {error && <div className="settings-notice settings-error" role="alert"><p>{error}</p>{conflict ? <><p>The file changed since it was loaded. Reload discards your draft and loads the latest values.</p><button className="btn" disabled={busy} onClick={() => setReload((n) => n + 1)}>Reload latest settings</button></> : !snapshot && <button className="btn" disabled={busy} onClick={() => setReload((n) => n + 1)}>Retry</button>}</div>}
      {success && <p className="settings-success" role="status">{success}</p>}
      {!snapshot && busy && <p role="status">Loading settings…</p>}
      {snapshot && <form id="settings-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {sections.map((section) => <details className="settings-section" key={section.title} open={section.title === 'claude task profiles'}><summary>{section.title}</summary>{section.help && <p>{section.help}</p>}{section.title === 'codex task profiles' && <><p>Recommendations: Astra medium for orchestration, Sol medium for implementation, Luna high for exploration, Luna low for mechanical tasks, Sol high for review.</p><button className="btn" type="button" disabled={busy} onClick={() => { setDrafts((d) => ({ ...d, ...codexRecommendations })); setSuccess(''); }}>Stage recommended Codex defaults</button><p>Replaces this draft’s Codex profile values; review and Save to apply.</p></>}{section.fields.map(renderField)}</details>)}
      </form>}
    </div>
    <footer className="settings-footer"><span>{dirty ? 'Unsaved changes' : 'Changes are saved only when you choose Save.'}</span><button className="btn" disabled={busy || !dirty} onClick={() => { setDrafts({}); setError(''); setSuccess(''); }}>Cancel changes</button><button className="btn primary" form="settings-form" type="submit" disabled={busy || !snapshot || !dirty || conflict}>{busy ? 'Please wait…' : 'Save settings'}</button></footer>
  </dialog>;
}
