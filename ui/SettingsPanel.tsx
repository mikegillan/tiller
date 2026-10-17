import { useEffect, useRef, useState } from 'react';
import { token } from './url';
import { refreshUsage } from './conn';
import { useStore } from './store';
import { buildChanges, cliStatus, claudeRecommendations, codexRecommendations, efforts, fieldPreview, formatValue, groups, inputValue, profileFields, profiles, type Field, type Scope, type SettingsSnapshot } from './settings-model';
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
  const usageSources = useStore((s) => s.usageSources);
  const usageScanning = useStore((s) => s.usageScanning);
  const connected = useStore((s) => s.connected);
  const dialog = useRef<HTMLDialogElement>(null);
  const [category, setCategory] = useState('Claude');
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
    ...Object.keys(efforts).map((harness) => ({ title: harness === 'pi' ? 'Pi' : harness === 'codex' ? 'Codex' : 'Claude', help: 'Model and effort resolve independently. Spawn options and presets take precedence over these defaults.', fields: profileFields(harness as keyof typeof efforts) })),
    ...groups.filter((group) => !group.homeOnly || scope === 'home'),
  ];
  const active = sections.find((section) => section.title === category) ?? sections[0];
  const scopeLabel = scope === 'project' ? 'repository' : 'global';
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
  useEffect(() => { content.current?.scrollTo({ top: 0 }); }, [category, scope]);
  useEffect(() => { if (error || success || discard) content.current?.scrollTo({ top: 0 }); }, [error, success, discard]);
  const leave = (target: Scope | 'close') => {
    if (busy || target === scope) return;
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
    const { drafted, explicit, entry, raw, previewUnavailable } = fieldPreview(snapshot, drafts, field);
    const fallback = snapshot.inherited[key];
    const action = explicit ? scope === 'project' ? 'Remove repository override' : 'Use inherited default' : scope === 'project' ? 'Customize for this repository' : 'Customize globally';
    const id = `setting-${key}`;
    const props = { id, disabled: busy || !explicit, value: raw, placeholder: previewUnavailable ? 'Preview available after save' : undefined, 'aria-describedby': `${id}-help`, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => edit(key, e.target.value) };
    return <div className="settings-field" key={key}>
      <label htmlFor={id}>{key.startsWith('profiles.') ? key.endsWith('.model') ? 'Model' : 'Effort' : label}</label>
      <div className="settings-control">
        {field.options || field.type === 'boolean' ? <select {...props}>
          {!raw && <option value="">{previewUnavailable ? 'Preview available after save' : 'Harness default / unset'}</option>}
          {field.options && raw && !field.options.includes(raw) && <option value={raw}>{raw} (current)</option>}
          {(field.options ?? ['true', 'false']).map((option) => <option key={option} value={option}>{option}</option>)}
        </select> : field.type === 'lines' ? <textarea {...props} rows={3} /> : <input {...props} list={key.startsWith('profiles.claude.') && key.endsWith('.model') ? 'settings-claude-models' : undefined} type={field.type === 'number' ? 'number' : 'text'} min={field.min} step={field.integer ? 1 : 'any'} />}
        <button className="btn" type="button" disabled={busy} aria-label={`${action}: ${label}`} onClick={() => edit(key, explicit ? null : inputValue(previewUnavailable ? undefined : fallback?.value ?? (field.type === 'boolean' ? false : ''), field))}>{action}</button>
      </div>
      <div className="settings-detail" id={`${id}-help`}>
        {field.help && !key.startsWith('profiles.') && <div>{field.help}</div>}
        {previewUnavailable ? <div className="settings-pending">Preview unavailable until legacy role changes are saved.</div> : <><div className={drafted ? 'settings-pending' : undefined}><span>{drafted ? 'After save: ' : 'Effective: '}</span><code>{formatValue(entry?.value)}</code><span> · {explicit ? `Customized ${scope === 'project' ? 'for this repository' : 'globally'}` : entry?.source === 'default' && entry?.value !== undefined ? 'Tiller default' : 'Inherited'}</span></div>
        <details className="settings-source"><summary>Value source</summary><code>{entry?.source === 'default' ? entry.value === undefined ? 'Harness default / unset' : 'Tiller default' : entry?.source ?? 'Harness default'}</code></details></>}
      </div>
    </div>;
  }
  return <dialog className="settings-dialog" ref={dialog} aria-labelledby="settings-title" onCancel={(event) => { event.preventDefault(); leave('close'); }} onKeyDown={(event) => event.stopPropagation()}>
    <header className="settings-header"><h2 id="settings-title">Settings</h2><button className="btn" disabled={busy} onClick={() => leave('close')}>Close</button></header>
    <div className="settings-scope" role="group" aria-label="Settings scope">
      <button className={`btn${scope === 'project' ? ' primary' : ''}`} aria-pressed={scope === 'project'} disabled={!nodeId || busy} onClick={() => leave('project')}>Repository</button>
      <button className={`btn${scope === 'home' ? ' primary' : ''}`} aria-pressed={scope === 'home'} disabled={busy} onClick={() => leave('home')}>Global · all repositories</button>
      {!nodeId && <span>Select a node to edit its repository settings.</span>}
    </div>
    <div className="settings-target"><strong>{scope === 'project' ? snapshot?.projectPath?.split('/').filter(Boolean).at(-1) ?? 'Repository settings' : 'Defaults for all repositories'}</strong>
      <p>{scope === 'project' ? 'Overrides shared defaults for this repository. Unset fields use global or built-in defaults; Claude profiles can also fall back to repository legacy roles.' : 'Used by every repository unless it has an override. Daemon settings are global only.'}</p>
      <details className="settings-path"><summary>{scope === 'project' ? snapshot?.projectPath ?? 'Loading repository…' : 'Configuration file'}</summary><code>{snapshot?.path ?? 'Loading target…'}</code></details>
    </div>
    <nav className="settings-categories" aria-label="Settings categories">{sections.map((section) => <button key={section.title} className="btn" aria-pressed={active.title === section.title && category !== 'CLI diagnostics'} onClick={() => setCategory(section.title)}>{section.title}{section.title === 'Daemon' ? ' (global only)' : ''}</button>)}<button className="btn" aria-pressed={category === 'CLI diagnostics'} onClick={() => setCategory('CLI diagnostics')}>CLI diagnostics</button></nav>
    <div className="settings-content" ref={content} aria-busy={busy}>
      {discard && <div className="settings-notice" role="alert"><p>Discard unsaved changes?</p><button className="btn" onClick={() => setDiscard(null)}>Keep editing</button>{' '}<button className="btn danger" onClick={() => { const target = discard; setDiscard(null); setDrafts({}); if (target === 'close') onClose(); else setScope(target); }}>Discard changes</button></div>}
      {(error || conflict) && <div className="settings-notice settings-error" role="alert"><p>{error || 'Settings changed on disk. Reload the latest settings before saving.'}</p>{conflict ? <><p>The file changed since it was loaded. Reload discards your draft and loads the latest values.</p><button className="btn" disabled={busy} onClick={() => setReload((n) => n + 1)}>Reload latest settings</button></> : !snapshot && <button className="btn" disabled={busy} onClick={() => setReload((n) => n + 1)}>Retry</button>}</div>}
      {success && <p className="settings-success" role="status">{success}</p>}
      {!snapshot && busy && <p role="status">Loading settings…</p>}
      {category === 'CLI diagnostics' && <section className="settings-clis" aria-labelledby="settings-clis-title">
        <div className="settings-clis-heading"><h3 id="settings-clis-title">Supported CLIs</h3><button className="btn" disabled={!connected || usageSources === undefined || usageScanning} onClick={refreshUsage}>{usageScanning ? 'Scanning tools…' : 'Rescan'}</button></div>
        {!usageSources && <p>CLI detection is unavailable from this daemon. Update the daemon to enable discovery and rescan.</p>}
        <p>Executable checks use the daemon’s launch PATH. Sign-in and quota availability are separate.</p>
        {!connected && <p>Daemon disconnected. Showing retained checks.</p>}
        <ul>{(['claude', 'codex', 'pi'] as const).map((tool) => {
          const source = usageSources?.find((source) => source.id === `discovery:${tool}`);
          return <li key={tool}><strong>{tool}</strong><span>{cliStatus(source)}</span>{source?.version && <small>Version: {source.version}</small>}{source?.detail && <small>{source.detail}</small>}{source?.checkedAt !== undefined && <small>Checked <time dateTime={new Date(source.checkedAt).toISOString()}>{new Date(source.checkedAt).toLocaleString()}</time></small>}</li>;
        })}</ul>
      </section>}
      {snapshot && <form id="settings-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <datalist id="settings-claude-models">{['opus', 'sonnet', 'haiku'].map((model) => <option key={model} value={model} />)}</datalist>
        {category !== 'CLI diagnostics' && <section className="settings-section" aria-labelledby="settings-category-title">
          <h3 id="settings-category-title">{active.title}{['Claude', 'Codex', 'Pi'].includes(active.title) ? ' task profiles' : ''}</h3>
          {active.help && <p>{active.help}</p>}
          {['Claude', 'Codex', 'Pi'].includes(active.title) ? <>
            {active.title === 'Claude' && <details className="settings-inheritance"><summary>How Claude inherits defaults</summary><p>Profile values take precedence over legacy role defaults, regardless of scope. Preview assumes orchestrator role for orchestration and worker role for other profiles. While legacy role changes are pending, dependent previews are unavailable until you save.</p></details>}
            {active.title !== 'Pi' && <details className="settings-recommendations"><summary>Recommended {active.title} defaults</summary>
              <p>Tiller supplies these defaults automatically when no configured profile or legacy role value applies. Staging customizes the listed values for this scope; review below, then save to {scopeLabel} settings.</p>
              <table><thead><tr><th>Task profile</th><th>Model</th><th>Effort</th></tr></thead><tbody>{profiles.map((profile) => {
                const recommended = active.title === 'Claude' ? claudeRecommendations : codexRecommendations;
                const prefix = `profiles.${active.title.toLowerCase()}.${profile}`;
                return <tr key={profile}><th scope="row">{profile}</th><td>{recommended[`${prefix}.model`]}</td><td>{recommended[`${prefix}.effort`] ?? 'CLI default when unset'}</td></tr>;
              })}</tbody></table>
              {active.title === 'Claude' && <p>Stable Claude CLI aliases; their versions and availability depend on your provider. Effort is left to the CLI when unset. Staging changes models only and retains every configured effort. Custom model IDs remain editable. <a href="https://code.claude.com/docs/en/model-config#model-aliases" target="_blank" rel="noreferrer">Claude model reference</a></p>}
              <button className="btn" type="button" disabled={busy} onClick={() => { setDrafts((d) => ({ ...d, ...(active.title === 'Claude' ? claudeRecommendations : codexRecommendations) })); setSuccess(`${active.title} defaults staged. Review the values, then save ${scopeLabel} settings.`); setError(''); }}>Stage recommended {active.title} defaults</button>
            </details>}
            {profiles.map((profile, index) => <fieldset className="settings-profile" key={profile}><legend>{profile.charAt(0).toUpperCase() + profile.slice(1)}</legend>{active.fields.slice(index * 2, index * 2 + 2).map(renderField)}</fieldset>)}
          </> : active.fields.map(renderField)}
        </section>}
      </form>}
    </div>
    <footer className="settings-footer"><span>{dirty ? `Unsaved ${scopeLabel} changes` : `Save applies to ${scope === 'project' ? 'this repository only' : 'all repositories without overrides'}.`}</span><button className="btn" disabled={busy || !dirty} onClick={() => { setDrafts({}); setError(''); setSuccess(''); }}>Cancel changes</button><button className="btn primary" form="settings-form" type="submit" disabled={busy || !snapshot || !dirty || conflict}>{busy ? 'Please wait…' : `Save ${scopeLabel} settings`}</button></footer>
  </dialog>;
}
