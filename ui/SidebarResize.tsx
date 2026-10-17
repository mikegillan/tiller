import { useLayoutEffect, useRef, useState } from 'react';

const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 240;
const MAX_WIDTH = 640;
const STORAGE_KEY = 'tl.sidebarWidth';

/** Reserve the open details panel, then keep 360px for the terminal (60% of narrower remaining space). */
export function sidebarBounds(viewport: number, panelOpen = false) {
  const available = Math.max(0, viewport - (panelOpen ? 320 : 0));
  const max = Math.floor(Math.min(MAX_WIDTH, available - Math.min(360, available * 0.6)));
  return { min: Math.min(MIN_WIDTH, max), max };
}

export function sidebarWidth(preferred: number, viewport: number, panelOpen = false) {
  const { min, max } = sidebarBounds(viewport, panelOpen);
  return Math.round(Math.min(max, Math.max(min, preferred)));
}

export function readSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY), value = raw === null ? NaN : Number(raw);
    if (Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH) return value;
  } catch { /* per-viewer convenience only */ }
  return DEFAULT_WIDTH;
}

export function saveSidebarWidth(width: number) {
  try { localStorage.setItem(STORAGE_KEY, String(width)); } catch { /* resizing still works without storage */ }
}

/** Local layout preference: resizing the window clamps the view without changing the saved desktop width. */
export function SidebarResize({ panelOpen }: { panelOpen: boolean }) {
  const handle = useRef<HTMLDivElement>(null);
  const [preferred, setPreferred] = useState(readSidebarWidth);
  const latest = useRef(preferred);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ id: number; x: number; width: number; preferred: number } | null>(null);
  const { min, max } = sidebarBounds(viewport, panelOpen);
  const width = sidebarWidth(preferred, viewport, panelOpen);
  const change = (value: number) => { latest.current = value; setPreferred(value); };

  useLayoutEffect(() => {
    const el = handle.current!, app = el.closest<HTMLElement>('.app')!;
    const previous = app.style.getPropertyValue('--sidebar-width');
    setViewport(app.clientWidth);
    const observer = new ResizeObserver(() => setViewport(app.clientWidth));
    observer.observe(app);
    return () => {
      observer.disconnect();
      const active = drag.current;
      drag.current = null;
      if (active && el.hasPointerCapture(active.id)) el.releasePointerCapture(active.id);
      if (previous) app.style.setProperty('--sidebar-width', previous);
      else app.style.removeProperty('--sidebar-width');
    };
  }, []);

  useLayoutEffect(() => {
    handle.current?.closest<HTMLElement>('.app')?.style.setProperty('--sidebar-width', `${width}px`);
  }, [width]);

  const finish = (commit: boolean) => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if (commit) saveSidebarWidth(latest.current);
    else change(active.preferred);
    setResizing(false);
    if (handle.current?.hasPointerCapture(active.id)) handle.current.releasePointerCapture(active.id);
  };

  return <div ref={handle} className="sidebar-resize" role="separator" tabIndex={0}
    aria-label="Sidebar width" aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={width}
    aria-valuetext={`${width} pixels`} data-resizing={resizing || undefined}
    title="Drag to resize sidebar. Arrow keys resize; Home/End set minimum/maximum. Double-click to reset."
    onPointerDown={(e) => {
      if (e.button !== 0 || drag.current) return;
      e.preventDefault();
      e.currentTarget.focus();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { id: e.pointerId, x: e.clientX, width, preferred: latest.current };
      setResizing(true);
    }}
    onPointerMove={(e) => {
      const active = drag.current;
      if (!active || active.id !== e.pointerId) return;
      const next = sidebarWidth(active.width + e.clientX - active.x, viewport, panelOpen);
      if (next !== sidebarWidth(latest.current, viewport, panelOpen)) change(next);
    }}
    onPointerUp={(e) => { if (drag.current?.id === e.pointerId) finish(true); }}
    onPointerCancel={(e) => { if (drag.current?.id === e.pointerId) finish(false); }}
    onLostPointerCapture={() => finish(false)}
    onDoubleClick={() => { change(DEFAULT_WIDTH); saveSidebarWidth(DEFAULT_WIDTH); }}
    onKeyDown={(e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || drag.current) return;
      const step = e.shiftKey ? 40 : 16;
      const next = e.key === 'Home' ? min : e.key === 'End' ? max
        : e.key === 'ArrowLeft' ? Math.max(min, width - step) : e.key === 'ArrowRight' ? Math.min(max, width + step) : undefined;
      if (next === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      if (next !== width) { change(next); saveSidebarWidth(next); }
    }} />;
}
