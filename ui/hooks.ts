import { useEffect, useSyncExternalStore } from 'react';
import { titleFor } from './format';
import { useStore } from './store';
import { needsYou } from './tree';
import { syncUrl } from './url';

/** One shared clock so every age label updates together. */
let now = Date.now();
const subs = new Set<() => void>();
setInterval(() => { now = Date.now(); subs.forEach((f) => f()); }, 10_000);
export const useNow = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => now);

/** "(2) orchestr8" in the document title while nodes need you; keeps ?node= in step with the selection. */
export function useDocumentSync() {
  const needs = useStore((s) => Object.values(s.nodes).filter(needsYou).length);
  const selected = useStore((s) => s.selected);
  useEffect(() => { document.title = titleFor(needs); }, [needs]);
  useEffect(() => { syncUrl(selected); }, [selected]);
}
