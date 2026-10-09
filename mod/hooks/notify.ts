import type { Child } from '../types'

export const needsYou = (c: Child) => !c.exited && (c.state === 'blocked' || c.state === 'waiting')
export const kind = (c: Child) => (c.errored ? 'error' : needsYou(c) ? 'needs' : c.state === 'done' ? 'done' : '')

/** Toasts (and whether to also notify the OS) for descendants whose kind changed since `prev`. */
export function changes(prev: Child[], list: Child[]) {
  const out: { key: string; text: string; os: boolean }[] = []
  for (const c of list) {
    if (c.self) continue
    const was = prev.find(p => p.id === c.id)
    const k = kind(c)
    if (!was || !k || kind(was) === k) continue
    out.push({ key: c.id, text: k === 'done' ? `${c.title} finished` : k === 'error' ? `${c.title} errored` : `${c.title} needs you`, os: k !== 'done' })
  }
  return out
}

/** terminal-notifier lets a click focus the terminal; osascript's notification cannot. */
export const osCommand = (text: string, tn: boolean, bundle?: string) =>
  tn
    ? ['terminal-notifier', '-title', 'orchestr8', '-message', text, ...(bundle ? ['-activate', bundle] : [])]
    : ['osascript', '-e', `display notification "${text.replace(/[\\"]/g, '\\$&')}" with title "orchestr8"`]
