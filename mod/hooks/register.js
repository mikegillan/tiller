import { atom, read, update } from 'claude-code'

// orchestr8 per-node mod. Inert unless O8_NODE_ID is set. Contract: src/shared/protocol.ts "Mod-facing HTTP API".
const kids = atom({ plugin: 'orchestr8', key: 'children' }, [])
const pend = atom({ plugin: 'orchestr8', key: 'pending' }, 0)
const PANE = { id: 'o8-children', title: 'Children' }
let id, endpoint, token, parent, isMac, busy, tn, bundle
let prev = null
const inflight = new Set()
const lastToast = new Map()

const needsYou = c => c.state === 'blocked' || c.state === 'waiting'
const kind = c => (c.errored ? 'error' : needsYou(c) ? 'needs' : c.state === 'done' ? 'done' : '')

async function call($, method, path, body) {
  const r = await $.http.fetch(`${endpoint}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'X-O8-Node': id, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${path}: ${r.status} ${r.text}`)
  return r.text ? JSON.parse(r.text) : undefined
}

async function tool($, name, args) {
  try { const r = await call($, 'POST', `/api/${name}`, args); return r.text ?? (r.data === undefined ? '(no output)' : JSON.stringify(r.data)) } catch (err) { return `error: ${err.message}` }
}

// At most one toast / notification per key per 5 s.
async function notify($, key, text, os) {
  const now = await $.clock.now()
  if (now - (lastToast.get(key) ?? 0) < 5000) return
  lastToast.set(key, now)
  $.ui.toast(text)
  forward($, 'notified', { text, os: !!(os && isMac) })
  if (os && isMac) {
    // terminal-notifier lets a click focus the terminal; osascript's notification cannot.
    const cmd = tn
      ? ['terminal-notifier', '-title', 'orchestr8', '-message', text, ...(bundle ? ['-activate', bundle] : [])]
      : ['osascript', '-e', `display notification "${text.replace(/[\\"]/g, '\\$&')}" with title "orchestr8"`]
    $.process.run(cmd).catch(() => {})
  }
}

async function diff($, list) {
  if (prev) {
    for (const c of list) {
      const was = prev.find(p => p.id === c.id)
      const k = kind(c)
      if (!was || !k || kind(was) === k) continue
      const text = k === 'done' ? `${c.title} finished` : k === 'error' ? `${c.title} errored` : `${c.title} needs you`
      await notify($, c.id, text, k !== 'done')
    }
  }
  prev = list
}

async function poll($) {
  if (busy) return
  busy = true
  try {
    const list = await call($, 'GET', '/children')
    await update($, kids, () => list)
    await diff($, list)
    const msgs = (await call($, 'GET', '/inbox')).filter(m => !inflight.has(m.id))
    await update($, pend, () => inflight.size + msgs.length)
    for (const m of msgs) {
      inflight.add(m.id)
      await notify($, `msg:${m.from}`, `message from ${m.from}`, false)
      // submit resolves once the prompt is accepted (session idle); ack after that.
      $.prompt.submit({ text: m.text, asUser: true }).then(async () => {
        await call($, 'POST', '/ack', { id: m.id })
        inflight.delete(m.id)
        await update($, pend, n => Math.max(0, n - 1))
      }).catch(err => { inflight.delete(m.id); $.ui.log(`orchestr8: deliver ${m.id} failed: ${err}`) })
    }
  } catch (err) { $.ui.log(`orchestr8: poll error ${err}`) } finally { busy = false }
}

function forward($, event, payload) {
  if (id) call($, 'POST', '/mod-event', { event, payload }).catch(() => {})
}

const fit = (s, n) => (n <= 1 ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s)
const shortId = c => c.id.slice(-4)
const age = s => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`)
const mark = c => (c.errored ? '×' : c.exited ? '-' : needsYou(c) ? '!' : c.state === 'working' ? '*' : c.state === 'done' ? '✓' : '?')

export const register = on => {
  on('session.start', async ($, e, next) => {
    id = await $.env.get('O8_NODE_ID')
    if (!id) return next(e)
    endpoint = await $.env.get('O8_ENDPOINT')
    token = (await $.fs.read(await $.env.get('O8_TOKEN_FILE'))).trim()
    parent = await $.env.get('O8_PARENT_ID')
    try { isMac = (await $.process.run(['uname'])).stdout.trim() === 'Darwin' } catch { isMac = false }
    try { tn = isMac && !!(await $.process.run(['which', 'terminal-notifier'])).stdout.trim() } catch { tn = false }
    bundle = await $.env.get('O8_TERMINAL_BUNDLE')
    for (const [name, description] of [
      ['o8', 'Open the orchestr8 children pane'], ['o8-list', 'List orchestr8 nodes'],
      ['o8-spawn', 'Spawn a child: <title> :: <prompt>'], ['o8-send', 'Send a message: <nodeId> <text>'],
      ['o8-read', 'Read a node summary: <nodeId>'],
    ]) await $.command.register({ name, description })
    $.ui.open(PANE).catch(() => {})
    $.clock.every(1000, () => poll($))
    return next(e)
  })

  on('turn.start', ($, e, next) => { forward($, 'turn.start', e); return next(e) })
  on('turn.complete', ($, e, next) => { forward($, 'turn.complete', e); return next(e) })
  on('session.measure', ($, e, next) => { forward($, 'session.measure', e); return next(e) })

  on('command.run', { command: 'o8' }, async $ => {
    const r = await $.ui.open(PANE)
    return { text: r.isPlaced ? 'orchestr8 children pane opened.' : 'Terminal too narrow for the pane; widen it and run /o8 again.' }
  })
  on('command.run', { command: 'o8-list' }, async $ => ({ text: await tool($, 'list_nodes', {}) }))
  on('command.run', { command: 'o8-spawn' }, async ($, e) => {
    const [title, prompt] = e.args.split('::').map(s => s.trim())
    if (!title) return { text: 'usage: /o8-spawn <title> :: <prompt>' }
    const cwd = (await $.env.get('PWD')) || '.'
    return { text: await tool($, 'spawn', { kind: 'claude', title, cwd, prompt: prompt || undefined }) }
  })
  on('command.run', { command: 'o8-send' }, async ($, e) => {
    const [nodeId, ...text] = e.args.trim().split(/\s+/)
    if (!nodeId || !text.length) return { text: 'usage: /o8-send <nodeId> <text>' }
    return { text: await tool($, 'send', { nodeId, text: text.join(' ') }) }
  })
  on('command.run', { command: 'o8-read' }, async ($, e) => {
    const nodeId = e.args.trim()
    if (!nodeId) return { text: 'usage: /o8-read <nodeId>' }
    return { text: await tool($, 'read', { nodeId, what: 'summary' }) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!id) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const need = (await read($, kids)).filter(needsYou)
    const first = need[0]
    const needs = first ? `${need.length} needs you: ${first.title} [${shortId(first)}]` : '0 children need you'
    const par = parent ? ` · parent: ${parent}` : ''
    return h(Box, null, h(Text, { dimColor: true, wrap: 'truncate' }, `orchestr8 · node ${id}${par} · ${await read($, pend)} pending · ${needs}`))
  })

  on('ui.render', { component: 'Pane', requestId: 'o8-children' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, kids)
    const cols = e.viewport?.columns ?? 80
    if (!list.length) return h(Text, { dimColor: true }, 'No children.')
    return h(Box, { flexDirection: 'column' }, ...list.map(c => {
      const head = `${'  '.repeat(c.depth ?? 0)}[${shortId(c)}] ${mark(c)} ${c.title} ${c.state} ${c.activity ?? ''} ${age(c.ageSec)}${c.unread ? ' •' : ''}`
      // A node waiting on you shows its activity in full; the last message only fills spare room on other rows.
      return h(Text, { key: c.id, wrap: 'truncate', bold: needsYou(c) }, fit(needsYou(c) ? head : `${head}  ${c.lastMessage ?? ''}`, cols))
    }))
  })
}
