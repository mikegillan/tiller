import { useLayoutEffect, useRef, useState } from 'react';
import { isAgentKind, PROFILE_LABELS, profileFor, type NodeView } from '../src/shared/protocol';
import { fmtTokens, shortModel } from '../src/shared/format';
import { CtxBar, DiffCounts, StateDot } from './Bits';
import { Icon } from './icons';
import { KIND_LABEL, kindTag, statusKind } from './tree';
import './sidebar-inspector.css';

const STORAGE_KEY = 'tl.sidebarInspectorHeight';
const DEFAULT_HEIGHT = 300;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 560;
const clampPreference = (height: number) => Math.round(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, height)));

/** Reserve 120px for the tree; in short windows share the remaining space. */
export function inspectorBounds(available: number) {
  const space = Math.max(0, available);
  const max = Math.floor(Math.min(MAX_HEIGHT, space - Math.min(120, space * 0.45)));
  return { min: Math.min(MIN_HEIGHT, max), max };
}

export function inspectorHeight(preferred: number, available: number) {
  const { min, max } = inspectorBounds(available);
  return Math.round(Math.max(min, Math.min(max, preferred)));
}

export function readInspectorHeight() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY), height = raw === null ? NaN : Number(raw);
    if (Number.isFinite(height) && height >= MIN_HEIGHT && height <= MAX_HEIGHT) return height;
  } catch { /* Layout preferences are optional. */ }
  return DEFAULT_HEIGHT;
}

function saveHeight(height: number) {
  try { localStorage.setItem(STORAGE_KEY, String(clampPreference(height))); } catch { /* Resizing works without storage. */ }
}

export function SidebarInspector({ node, onClose }: { node: NodeView | null; onClose: () => void }) {
  const root = useRef<HTMLElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const [preferred, setPreferred] = useState(readInspectorHeight);
  const latest = useRef(preferred);
  const [available, setAvailable] = useState(() => typeof window === 'undefined' ? 600 : window.innerHeight);
  const drag = useRef<{ id: number; y: number; height: number; preferred: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const { min, max } = inspectorBounds(available);
  const height = inspectorHeight(preferred, available);
  const change = (value: number) => {
    latest.current = clampPreference(value);
    setPreferred(latest.current);
  };

  useLayoutEffect(() => {
    const parent = root.current?.closest<HTMLElement>('.sidebar-session-body');
    if (!parent) return;
    const measure = () => setAvailable(Math.max(0, Math.min(parent.clientHeight, window.innerHeight - parent.getBoundingClientRect().top)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    window.addEventListener('resize', measure);
    const el = handle.current;
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      const active = drag.current;
      drag.current = null;
      if (active && el?.hasPointerCapture(active.id)) el.releasePointerCapture(active.id);
    };
  }, []);

  const finish = (commit: boolean) => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if (commit) saveHeight(latest.current);
    else change(active.preferred);
    setResizing(false);
    if (handle.current?.hasPointerCapture(active.id)) handle.current.releasePointerCapture(active.id);
  };

  const s = node?.status;
  const git = s?.git;
  const agent = node && isAgentKind(node.kind);
  const kind = node && statusKind(node);
  const row = (label: string, value: React.ReactNode) => <div className="inspector-fact"><dt>{label}</dt><dd>{value}</dd></div>;

  return <section id="sidebar-inspector" ref={root} aria-label="Selected node details" style={{ height }}>
    <div className="inspector-resize" ref={handle} role="separator" tabIndex={0}
      aria-label="Details height" aria-orientation="horizontal" aria-controls="sidebar-inspector-content"
      aria-valuemin={min} aria-valuemax={max} aria-valuenow={height} aria-valuetext={`${height} pixels`}
      data-resizing={resizing || undefined}
      title="Drag to resize details. Up/Down resize; Home/End set minimum/maximum. Double-click to reset."
      onPointerDown={(e) => {
        if (e.button !== 0 || drag.current) return;
        e.preventDefault();
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { id: e.pointerId, y: e.clientY, height, preferred: latest.current };
        setResizing(true);
      }}
      onPointerMove={(e) => {
        const active = drag.current;
        if (!active || active.id !== e.pointerId) return;
        const next = inspectorHeight(active.height + active.y - e.clientY, available);
        if (next !== inspectorHeight(latest.current, available)) change(next);
      }}
      onPointerUp={(e) => { if (drag.current?.id === e.pointerId) finish(true); }}
      onPointerCancel={(e) => { if (drag.current?.id === e.pointerId) finish(false); }}
      onLostPointerCapture={() => finish(false)}
      onDoubleClick={() => { change(DEFAULT_HEIGHT); saveHeight(DEFAULT_HEIGHT); }}
      onKeyDown={(e) => {
        if (e.altKey || e.ctrlKey || e.metaKey || drag.current) return;
        const step = e.shiftKey ? 40 : 16;
        const next = e.key === 'Home' ? min : e.key === 'End' ? max
          : e.key === 'ArrowUp' ? Math.min(max, height + step) : e.key === 'ArrowDown' ? Math.max(min, height - step) : undefined;
        if (next === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        if (next !== height) { change(next); saveHeight(next); }
      }} />
    <div id="sidebar-inspector-content" className="inspector-content">
      <header className="inspector-header">
        <h2>{node?.title || 'Node details'}</h2>
        <button className="inspector-close" onClick={onClose} aria-label="Close details" title="Close details"><Icon name="x" size={16} /></button>
      </header>
      {!node || !s || !kind ? <p className="inspector-empty">Select a node in this session to see its details.</p> : <>
        <dl className="inspector-facts">
          {row('Live status', <span className={`inspector-state ${kind}`}><StateDot kind={kind} />{KIND_LABEL[kind]}</span>)}
          {row('Harness', kindTag(node))}
          {agent && row('Role', node.role ?? (node.parentId ? 'worker' : 'orchestrator'))}
          {agent && row('Profile', PROFILE_LABELS[profileFor(node.profile, node.parentId, node.role)])}
          {agent && row('Model', shortModel(s.model ?? node.model) || 'Not reported')}
          {agent && row('Effort', s.effort ?? node.effort ?? 'Not reported')}
        </dl>
        {(node.unread || s.errored || s.interrupted || s.stale || s.stalled || node.pending?.blocked) && <p className="inspector-attention">
          {[node.unread && 'Unread message', s.errored && 'Turn errored', s.interrupted && 'Interrupted', s.stale && 'Stale status', s.stalled && 'Activity stalled', node.pending?.blocked].filter(Boolean).join(' · ')}
        </p>}
        <h3>Activity</h3>
        <p className="inspector-text">{s.activity || 'No activity reported.'}</p>
        {s.lastAssistantMessage && <details><summary>Last assistant message</summary><p className="inspector-text">{s.lastAssistantMessage}</p></details>}
        <h3>Workspace</h3>
        <dl className="inspector-facts">
          {row('Directory', <span className="inspector-path">{node.cwd}</span>)}
          {row('Branch', <span className="inspector-path">{node.worktree?.branch ?? git?.branch ?? 'Not reported'}</span>)}
          {node.worktree && row('Base', <span className="inspector-path">{node.worktree.base}</span>)}
          {node.worktree?.missing && row('Worktree', <span className="warn">Missing — resume unavailable</span>)}
          {git && <>
            {row('Commits', `${git.ahead} ahead · ${git.behind} behind ${git.base}`)}
            {row('Changes', <>{git.dirty} uncommitted file{git.dirty === 1 ? '' : 's'} · <DiffCounts git={git} /></>)}
            {git.mergedAt && row('Merge', `Merged into ${git.base}`)}
          </>}
        </dl>
        {agent && <><h3>Context</h3><p>{s.contextPct !== undefined ? <CtxBar pct={s.contextPct} /> : 'Not reported'}
          {s.contextTokens !== undefined && s.contextWindow !== undefined && <span className="inspector-tokens">{fmtTokens(s.contextTokens)} / {fmtTokens(s.contextWindow)} tokens</span>}
        </p></>}
        <h3>Completion</h3>
        <dl className="inspector-facts">
          {row('Reported outcome', node.outcome ? node.outcome.outcome : 'Not reported')}
          {row('Completion gate', node.gate ?? node.outcome?.gate ?? 'Not reported')}
        </dl>
        {node.outcome?.summary && <p className="inspector-text">{node.outcome.summary}</p>}
        {node.outcome?.note && <p className="inspector-text">{node.outcome.note}</p>}
      </>}
    </div>
  </section>;
}
