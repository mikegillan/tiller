import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { dndActive } from '../src/shared/protocol';
import { send } from './conn';
import { titleFor } from './format';
import { getState, selectNode, useStore } from './store';
import { trayState } from './tray';
import { needsYou } from './tree';
import { IN_APP, syncUrl } from './url';

/** One shared clock so every age label updates together. */
let now = Date.now();
const subs = new Set<() => void>();
setInterval(() => { now = Date.now(); subs.forEach((f) => f()); }, 10_000);
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export const useNow = () => useSyncExternalStore(subscribe, () => now);

type TauriWindow = { __TAURI_INTERNALS__?: { invoke: (cmd: string, args: object) => Promise<unknown> } };

/** Do not disturb for an hour, or off when it is on. */
export const toggleDnd = () => send(dndActive(getState().dnd, Date.now()) ? { t: 'dnd', on: false } : { t: 'dnd', on: true, minutes: 60 });

/** What the app's menu bar item calls on a click (src-tauri/src/lib.rs on_tray_menu). */
(window as { __o8tray?: (action: string, id?: string) => void }).__o8tray = (action, id) => {
  if (action === 'select' && id) selectNode(id);
  else if (action === 'dnd') toggleDnd();
};

/**
 * "(2) orchestr8" in the document title (and the Dock badge and menu bar item in the app) while nodes need you; keeps
 * ?node= in step with the selection.
 */
export function useDocumentSync() {
  const needs = useStore((s) => Object.values(s.nodes).filter(needsYou).length);
  const selected = useStore((s) => s.selected);
  const nodes = useStore((s) => s.nodes);
  const order = useStore((s) => s.order);
  const now = useNow();
  const quiet = useStore((s) => dndActive(s.dnd, now));
  const tray = useMemo(() => JSON.stringify({ ...trayState(order.map((id) => nodes[id])), dnd: quiet }), [nodes, order, quiet]);
  useEffect(() => {
    document.title = titleFor(needs);
    if (IN_APP) (window as TauriWindow).__TAURI_INTERNALS__?.invoke('plugin:window|set_badge_count', { count: needs || null }).catch(() => {});
  }, [needs]);
  useEffect(() => {
    if (IN_APP) (window as TauriWindow).__TAURI_INTERNALS__?.invoke('set_tray', JSON.parse(tray)).catch(() => {});
  }, [tray]);
  useEffect(() => { syncUrl(selected); }, [selected]);
}
