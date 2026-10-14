import { describe, expect, mock, test } from 'claude-code/testing'

const tree = [{ id: 'n1', title: 'boss', depth: 0, state: 'idle', ageSec: 0, unread: false, self: true, parentId: null }]

// Runs the mod's poll once against a stubbed daemon whose /tree answers with `clients` in X-TL-Clients.
async function drawn(clients: string, $: any, on: any) {
  const toasts: string[] = []
  const clock = mock.clock(on)
  mock.env(on, { TL_NODE_ID: 'n1', TL_TOKEN_FILE: '/t', TL_ENDPOINT: 'http://d' })
  on('fs.read', () => ({ value: 'tok' }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('ui.toast', ($: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('http.fetch', ($: any, e: any) => {
    const path = new URL(e.url).pathname
    return { value: { status: 200, ok: true, headers: path === '/tree' ? { 'x-tl-clients': clients } : {}, text: JSON.stringify(path === '/tree' ? tree : []) } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(1100)
  try {
    const ui = await $.ui.mount({ plugin: 'tiller', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 5 } as any })
    return { toasts, passedThrough: false, drawn: JSON.stringify(await ui.drawn()) }
  } catch (err) {
    // The kit has nothing beneath the plugins to draw the band, so a hook that passes reaches the bottom and mount rejects.
    return { toasts, passedThrough: /no implementation for ui.render/.test(String(err)), drawn: '' }
  }
}

describe('quiet while a tiller client is attached', () => {
  test('a client attached: the band draws nothing and nothing toasts', async ($, on) => {
    const r = await drawn('app', $, on)
    expect(r.passedThrough).toBe(true)
    expect(r.toasts).toEqual([])
  })
  test('no client: the band renders', async ($, on) => {
    const r = await drawn('', $, on)
    expect(r.passedThrough).toBe(false)
    expect(r.drawn).toContain('tiller ·')
  })
})
