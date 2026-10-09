import type { Child } from '../types'

export const needsYou = (c: Child) => !c.exited && (c.state === 'blocked' || c.state === 'waiting')
export const kind = (c: Child) => (c.errored ? 'error' : needsYou(c) ? 'needs' : c.state === 'done' ? 'done' : '')

/** Toasts for descendants whose kind changed since `prev`. */
export function changes(prev: Child[], list: Child[]) {
  const out: { key: string; text: string }[] = []
  for (const c of list) {
    if (c.self) continue
    const was = prev.find(p => p.id === c.id)
    const k = kind(c)
    if (!was || !k || kind(was) === k) continue
    out.push({ key: c.id, text: k === 'done' ? `${c.title} finished` : k === 'error' ? `${c.title} errored` : `${c.title} needs you` })
  }
  return out
}
