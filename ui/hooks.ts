import { useEffect, useSyncExternalStore } from 'react';
import { titleFor } from './format';
import { useStore } from './store';
import { needsYou } from './tree';
import { IN_APP, syncUrl } from './url';

/** One shared clock so every age label updates together. */
let now = Date.now();
const subs = new Set<() => void>();
setInterval(() => { now = Date.now(); subs.forEach((f) => f()); }, 10_000);
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export const useNow = () => useSyncExternalStore(subscribe, () => now);

type TauriWindow = { __TAURI_INTERNALS__?: { invoke: (cmd: string, args: object) => Promise<unknown> } };

/** "(2) orchestr8" in the document title (and the Dock badge in the app) while nodes need you; keeps ?node= in step with the selection. */
export function useDocumentSync() {
  const needs = useStore((s) => Object.values(s.nodes).filter(needsYou).length);
  const selected = useStore((s) => s.selected);
  useEffect(() => {
    document.title = titleFor(needs);
    if (IN_APP) (window as TauriWindow).__TAURI_INTERNALS__?.invoke('plugin:window|set_badge_count', { count: needs || null }).catch(() => {});
  }, [needs]);
  useEffect(() => { syncUrl(selected); }, [selected]);
}
