import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { Child } from '../types'
import { parse, request, type Ctx } from './api'
import { Band } from './band'
import { COMMANDS, parseSend, parseSpawn } from './commands'
import { changes } from './notify'

// orchestr8 per-node mod. Inert unless O8_NODE_ID is set. Contract: src/shared/protocol.ts "Mod-facing HTTP API".
const kids = atom({ plugin: 'orchestr8', key: 'children' } as const, [] as Child[])
const pend = atom({ plugin: 'orchestr8', key: 'pending' } as const, 0)
// True while any orchestr8 client (app, browser, mux) is attached: its sidebar makes everything the mod draws redundant.
const quietAtom = atom({ plugin: 'orchestr8', key: 'quiet' } as const, false)
let quiet = false
let ctx: Ctx | undefined
let parent: string | undefined, busy = false
let prev: Child[] | null = null
const inflight = new Set<string>()
const lastToast = new Map<string, number>()

async function call($: any, method: string, path: string, body?: unknown) {
  const [url, init] = request(ctx!, method, path, body)
  return parse(path, await $.http.fetch(url, init))
}

async function tool($: any, name: string, args: unknown): Promise<string> {
  try { const r = await call($, 'POST', `/api/${name}`, args); return r.text ?? (r.data === undefined ? '(no output)' : JSON.stringify(r.data)) } catch (err) { return `error: ${err}` }
}

async function focus($: any, id: string, label: string) {
  try { await call($, 'POST', '/focus', { id }); $.ui.toast(`→ ${label}`) } catch (err) { $.ui.toast(`orchestr8: focus failed: ${err}`) }
}

function forward($: any, event: string, payload: unknown) {
  if (ctx) call($, 'POST', '/mod-event', { event, payload }).catch(() => {})
}

// At most one toast per key per 5 s. OS notifications are the daemon's job, not the mod's.
async function notify($: any, key: string, text: string) {
  const now = await $.clock.now()
  if (quiet || now - (lastToast.get(key) ?? 0) < 5000) return
  lastToast.set(key, now)
  $.ui.toast(text)
}

async function poll($: any) {
  if (busy) return
  busy = true
  try {
    const [url, init] = request(ctx!, 'GET', '/tree')
    const res = await $.http.fetch(url, init)
    const list: Child[] = parse('/tree', res)
    const q = !!res.headers['x-o8-clients']
    if (q !== quiet) {
      quiet = q
      if (!q) prev = null // what changed while quiet is not news: the next diff is a baseline
      await update($, quietAtom, () => q)
    }
    await update($, kids, () => list)
    if (prev) for (const c of changes(prev, list)) await notify($, c.key, c.text)
    prev = list
    const msgs = (await call($, 'GET', '/inbox')).filter((m: any) => !inflight.has(m.id))
    await update($, pend, () => inflight.size + msgs.length)
    for (const m of msgs) {
      inflight.add(m.id)
      await notify($, `msg:${m.from}`, `message from ${m.from}`)
      // submit resolves once the prompt is accepted (session idle); ack after that.
      $.prompt.submit({ text: m.text, asUser: true }).then(async () => {
        await call($, 'POST', '/ack', { id: m.id })
        inflight.delete(m.id)
        await update($, pend, (n: number) => Math.max(0, n - 1))
      }).catch((err: unknown) => { inflight.delete(m.id); { if (!quiet) $.ui.log(`orchestr8: deliver ${m.id} failed: ${err}`) } })
    }
  } catch (err) { if (!quiet) $.ui.log(`orchestr8: poll error ${err}`) } finally { busy = false }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const id = await $.env.get('O8_NODE_ID')
    if (!id) return next(e)
    const token = (await $.fs.read((await $.env.get('O8_TOKEN_FILE'))!)).trim()
    ctx = { id, endpoint: (await $.env.get('O8_ENDPOINT'))!, token }
    parent = (await $.env.get('O8_PARENT_ID')) || undefined
    for (const [name, description] of COMMANDS) await $.command.register({ name, description })
    $.clock.every(1000, () => poll($))
    return next(e)
  })

  on('turn.start', ($, e, next) => { forward($, 'turn.start', e); return next(e) })
  on('turn.complete', ($, e, next) => { forward($, 'turn.complete', e); return next(e) })
  on('session.measure', ($, e, next) => { forward($, 'session.measure', e); return next(e) })

  on('command.run', { command: 'o8-list' }, async $ => ({ text: await tool($, 'list_nodes', {}) }))
  on('command.run', { command: 'o8-spawn' }, async ($, e) => {
    const a = parseSpawn(e.args)
    if (!a) return { text: 'usage: /o8-spawn <title> :: <prompt>' }
    return { text: await tool($, 'spawn', { kind: 'claude', cwd: (await $.env.get('PWD')) || '.', ...a }) }
  })
  on('command.run', { command: 'o8-send' }, async ($, e) => {
    const a = parseSend(e.args)
    return { text: a ? await tool($, 'send', a) : 'usage: /o8-send <nodeId> <text>' }
  })
  on('command.run', { command: 'o8-read' }, async ($, e) => {
    const nodeId = e.args.trim()
    return { text: nodeId ? await tool($, 'read', { nodeId, what: 'summary' }) : 'usage: /o8-read <nodeId>' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!ctx || (await read($, quietAtom))) return next(e)
    const id = ctx.id
    return Band($.ui.resolve(e), id, await read($, kids), await read($, pend), parent, (to, label) => focus($, to, label))
  })
}
