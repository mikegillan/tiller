import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { Child } from '../types'
import { parse, request, type Ctx } from './api'
import { Band } from './band'
import { COMMANDS, parseSend, parseSpawn } from './commands'
import { changes } from './notify'
import { sendResult, sentLine } from './rows'

// tiller per-node mod. Inert unless TL_NODE_ID is set. Contract: src/shared/protocol.ts "Mod-facing HTTP API".
const kids = atom({ plugin: 'tiller', key: 'children' } as const, [] as Child[])
const pend = atom({ plugin: 'tiller', key: 'pending' } as const, 0)
// True while any tiller client (app or browser) is attached: its sidebar makes everything the mod draws redundant.
const quietAtom = atom({ plugin: 'tiller', key: 'quiet' } as const, false)
let quiet = false
let ctx: Ctx | undefined
let parent: string | undefined, busy = false
// The running turn's id, from turn.start; unknown after a hot reload mid-turn, when messages are submitted as before.
let turn: string | undefined, endedTurn: string | undefined
let prev: Child[] | null = null
const inflight = new Set<string>()
// Submitted but not yet acked: only the ack is retried (each poll), never the submit; the daemon would accept a second claim.
const unacked = new Set<string>()
const lastToast = new Map<string, number>()

async function call($: any, method: string, path: string, body?: unknown) {
  const [url, init] = request(ctx!, method, path, body)
  return parse(path, await $.http.fetch(url, init))
}

async function tool($: any, name: string, args: unknown): Promise<string> {
  try { const r = await call($, 'POST', `/api/${name}`, args); return r.text ?? (r.data === undefined ? '(no output)' : JSON.stringify(r.data)) } catch (err) { return `error: ${err}` }
}

async function focus($: any, id: string, label: string) {
  try { await call($, 'POST', '/focus', { id }); $.ui.toast(`→ ${label}`) } catch (err) { $.ui.toast(`tiller: focus failed: ${err}`) }
}

async function ack($: any, id: string) {
  try {
    await call($, 'POST', '/ack', { id })
    unacked.delete(id)
    inflight.delete(id)
  } catch (err) {
    if (!unacked.has(id) && !quiet) $.ui.log(`tiller: ack ${id} failed, retrying: ${err}`)
    unacked.add(id)
  }
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
    const q = !!res.headers['x-tl-clients']
    if (q !== quiet) {
      quiet = q
      if (!q) prev = null // what changed while quiet is not news: the next diff is a baseline
      await update($, quietAtom, () => q)
    }
    await update($, kids, () => list)
    // Should a turn.complete never reach this hook (another plugin's hook answering without next), messages would be held
    // until they expire; so release the hold once the daemon has seen this turn end on two polls in a row.
    const ended = turn !== undefined && list.find(c => c.self)?.state === 'done'
    if (ended && endedTurn === turn) turn = undefined
    endedTurn = ended ? turn : undefined
    if (prev) for (const c of changes(prev, list)) await notify($, c.key, c.text)
    prev = list
    const all: any[] = await call($, 'GET', '/inbox')
    const msgs = all.filter(m => !inflight.has(m.id)) // before the retries below take acked ids out of inflight
    for (const id of unacked) {
      // Gone from the inbox: acked by the UserPromptSubmit hook, or retired. Otherwise retry the ack.
      if (all.some(m => m.id === id)) await ack($, id)
      else { unacked.delete(id); inflight.delete(id) }
    }
    await update($, pend, () => inflight.size + msgs.length)
    for (const m of msgs) {
      // While a turn runs, hold a message in the daemon so its sender can still withdraw it; a steer goes now.
      if (turn && !m.steer) continue
      inflight.add(m.id)
      try { await call($, 'POST', '/claim', { id: m.id }) } catch { inflight.delete(m.id); continue } // withdrawn or expired
      if (m.steer && turn) await $.turn.abort({ turnId: turn }).catch(() => {}) // the turn may have just ended
      await notify($, `msg:${m.from}`, `message from ${m.from}`)
      // submit resolves once the prompt is accepted (session idle); ack after that.
      $.prompt.submit({ text: m.text, asUser: true }).then(
        () => ack($, m.id),
        (err: unknown) => { inflight.delete(m.id); if (!quiet) $.ui.log(`tiller: deliver ${m.id} failed: ${err}`) })
    }
  } catch (err) { if (!quiet) $.ui.log(`tiller: poll error ${err}`) } finally { busy = false }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const id = await $.env.get('TL_NODE_ID')
    if (!id) return next(e)
    const token = (await $.fs.read((await $.env.get('TL_TOKEN_FILE'))!)).trim()
    ctx = { id, endpoint: (await $.env.get('TL_ENDPOINT'))!, token }
    parent = (await $.env.get('TL_PARENT_ID')) || undefined
    for (const [name, description] of COMMANDS) await $.command.register({ name, description })
    $.clock.every(1000, () => poll($))
    return next(e)
  })

  on('turn.start', ($, e, next) => { turn = e.turnId; forward($, 'turn.start', e); return next(e) })
  on('turn.complete', ($, e, next) => { if (turn === e.turnId) turn = undefined; forward($, 'turn.complete', e); return next(e) })
  on('session.measure', ($, e, next) => { forward($, 'session.measure', e); return next(e) })

  on('command.run', { command: 'tl-list' }, async $ => ({ text: await tool($, 'list_nodes', {}) }))
  on('command.run', { command: 'tl-spawn' }, async ($, e) => {
    const a = parseSpawn(e.args)
    if (!a) return { text: 'usage: /tl-spawn <title> :: <prompt>' }
    return { text: await tool($, 'spawn', { kind: 'claude', cwd: (await $.env.get('PWD')) || '.', ...a }) }
  })
  on('command.run', { command: 'tl-send' }, async ($, e) => {
    const a = parseSend(e.args)
    return { text: a ? await tool($, 'send', a) : 'usage: /tl-send <nodeId> <text>' }
  })
  on('command.run', { command: 'tl-read' }, async ($, e) => {
    const nodeId = e.args.trim()
    return { text: nodeId ? await tool($, 'read', { nodeId, what: 'summary' }) : 'usage: /tl-read <nodeId>' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!ctx || (await read($, quietAtom))) return next(e)
    const id = ctx.id
    return Band($.ui.resolve(e), id, await read($, kids), await read($, pend), parent, (to, label) => focus($, to, label))
  })

  // Received messages are drawn by the tiller-rows plugin (mod-rows/): the engine skips this plugin's hooks on rows its own submit made.
  on('ui.render', { component: 'ToolUse', props: { tool: 'mcp__tiller__send' } }, async ($, e, next) => {
    // isExpanded is optional here: a surface that does not say (an export) draws in full.
    if (e.props.isExpanded !== false || e.props.isErrored || e.props.isInterrupted) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor wrap="truncate-end">{sentLine(e.props.input, e.props.output, e.props.isRunning, await read($, kids))}</Text>
  })
  // The outcome is on the call's own line, so its result block draws nothing until expanded; a failed send's shows its reason.
  on('ui.render', { component: 'ToolResult', props: { tool: 'mcp__tiller__send' } }, async ($, e, next) => {
    const outcome = sendResult(e.props.output)?.outcome
    if (e.props.isExpanded !== false || e.props.isErrored || (outcome !== 'queued' && outcome !== 'delivered')) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}
