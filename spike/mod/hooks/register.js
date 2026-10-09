import { atom, read, update } from 'claude-code'

// orchestr8 spike mod: reports turn events to the daemon and delivers its inbox via $.prompt.submit.
const kids = atom({ plugin: 'o8-mod', key: 'children' }, [])
const MARK = { working: '*', done: 'v', blocked: '!' }
let id, endpoint, token
let pending = 0
const inflight = new Set()

function send($, path, body) {
  return $.http.fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ node: id, ...body }),
  })
}

export const register = on => {
  on('session.start', async ($, e, next) => {
    id = await $.env.get('O8_NODE_ID')
    endpoint = await $.env.get('O8_ENDPOINT')
    token = (await $.fs.read(await $.env.get('O8_TOKEN_FILE'))).trim()
    $.ui.log(`o8-mod loaded node=${id} endpoint=${endpoint}`)
    $.ui.open({ id: 'o8-children', title: 'Children' }).then(r => $.ui.log(`o8-mod pane open: ${JSON.stringify(r)}`))
    await $.command.register({ name: 'o8-children', description: 'Open the orchestr8 children pane' })
    $.clock.every(1000, async () => {
      try {
        const c = await $.http.fetch(`${endpoint}/children?node=${id}`, { headers: { Authorization: `Bearer ${token}` } })
        await update($, kids, () => JSON.parse(c.text))
        const r = await $.http.fetch(`${endpoint}/inbox?node=${id}`, { headers: { Authorization: `Bearer ${token}` } })
        const msgs = JSON.parse(r.text).filter(m => !inflight.has(m.id))
        pending = inflight.size + msgs.length
        for (const m of msgs) {
          inflight.add(m.id)
          $.ui.toast(`message from ${m.from}`)
          // submit resolves once the prompt is accepted (session idle); ack after that.
          $.prompt.submit({ text: m.text, asUser: true }).then(async () => {
            inflight.delete(m.id)
            await send($, '/ack', { id: m.id })
          })
        }
      } catch (err) { $.ui.log(`o8-mod poll error ${err}`) }
    })
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (endpoint) send($, '/mod-event', { event: 'turn.start', payload: e }).catch(() => {})
    return next(e)
  })
  on('turn.complete', ($, e, next) => {
    if (endpoint) send($, '/mod-event', { event: 'turn.complete', payload: e }).catch(() => {})
    return next(e)
  })
  on('session.measure', ($, e, next) => {
    if (endpoint) send($, '/mod-event', { event: 'session.measure', payload: e }).catch(() => {})
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (!id) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return h(Box, null, h(Text, { dimColor: true }, `orchestr8 node ${id} · ${pending} pending`))
  })

  on('command.run', { command: 'o8-children' }, async $ => {
    const r = await $.ui.open({ id: 'o8-children', title: 'Children' })
    return { text: `children pane: ${JSON.stringify(r)}` }
  })

  on('ui.render', { component: 'Pane', requestId: 'o8-children' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, kids)
    return h(Box, { flexDirection: 'column' }, ...list.map(c =>
      h(Text, { key: c.title }, `${MARK[c.state]} ${c.title} [${c.state}] ${c.activity} (${c.ageSec}s) ${c.lastMessage}`)))
  })
}
