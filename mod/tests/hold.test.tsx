import { describe, expect, mock, test } from 'claude-code/testing'

describe('holding messages while a turn runs', () => {
  test('a message is held during a turn and released once the daemon has seen the turn end, even with no turn.complete', async ($, on) => {
    let state = 'working'
    const claims: string[] = []
    const clock = mock.clock(on)
    mock.env(on, { O8_NODE_ID: 'n1', O8_TOKEN_FILE: '/t', O8_ENDPOINT: 'http://d' })
    on('fs.read', () => ({ value: 'tok' }))
    on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
    on('ui.toast', () => ({ value: undefined }))
    on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
    on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
    on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
    on('http.fetch', ($: any, e: any) => {
      const path = new URL(e.url).pathname
      if (path === '/claim') claims.push(JSON.parse(e.init.body).id)
      const body = path === '/tree' ? [{ id: 'n1', title: 'w', depth: 0, state, ageSec: 0, unread: false, self: true, parentId: null }]
        : path === '/inbox' ? (claims.length ? [] : [{ id: 'm1', from: 'p', text: 'hello' }]) : { ok: true }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(3100)
    expect(claims).toEqual([]) // held while the daemon shows the turn working

    state = 'done' // the Stop hook landed, but this mod never saw turn.complete
    await clock.advance(1000)
    expect(claims).toEqual([]) // one poll is not enough: it may predate the next turn's UserPromptSubmit
    await clock.advance(1000)
    expect(claims).toEqual(['m1'])
  })
})
