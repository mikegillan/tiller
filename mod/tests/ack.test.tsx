import { describe, expect, mock, test } from 'claude-code/testing'

describe('acking a delivered message', () => {
  test('a failed ack is retried and the message is never submitted twice', async ($, on) => {
    const submits: string[] = [], acks: string[] = []
    let claimed = false, acked = false
    const clock = mock.clock(on)
    mock.env(on, { TL_NODE_ID: 'n1', TL_TOKEN_FILE: '/t', TL_ENDPOINT: 'http://d' })
    on('fs.read', () => ({ value: 'tok' }))
    on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
    on('ui.toast', () => ({ value: undefined }))
    on('ui.log', () => ({ value: undefined }))
    on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
    on('prompt.submit', ($: any, e: any) => { submits.push(e.text); return { text: e.text } })
    on('http.fetch', ($: any, e: any) => {
      const path = new URL(e.url).pathname
      if (path === '/claim') claimed = true // the daemon accepts a repeated claim from a Claude mod
      if (path === '/ack') {
        acks.push(JSON.parse(e.init.body).id)
        if (acks.length === 1) return { value: { status: 503, ok: false, headers: {}, text: 'restarting' } }
        acked = true
      }
      const body = path === '/tree' ? [{ id: 'n1', title: 'w', depth: 0, state: 'done', ageSec: 0, unread: false, self: true, parentId: null }]
        : path === '/inbox' ? (acked ? [] : [{ id: 'm1', from: 'p', text: 'hello', ...(claimed ? { claimed: true } : {}) }]) : { ok: true }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.advance(1100)
    expect(submits).toEqual(['hello'])
    expect(acks).toEqual(['m1']) // failed: the message stays in the inbox, marked claimed
    await clock.advance(3000)
    expect(submits).toEqual(['hello'])
    expect(acks).toEqual(['m1', 'm1'])
  })
})
