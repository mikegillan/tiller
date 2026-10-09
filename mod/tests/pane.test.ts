import { expect, mock, test } from 'claude-code/testing'

const kids = [
  { id: 'n-self0001', title: 'boss', depth: 0, self: true, parentId: null, state: 'working', ageSec: 5, unread: false },
  { id: 'n-aaaa4cb2', title: 'builder', depth: 1, state: 'blocked', activity: 'Bash: rm -rf build', ageSec: 40, unread: true },
  { id: 'n-bbbb0002', title: 'tester', depth: 1, state: 'done', lastMessage: 'all green', ageSec: 200, unread: false },
]
const posts: { url: string; body?: string }[] = []
const env = { O8_NODE_ID: 'n-self0001', O8_ENDPOINT: 'http://d', O8_TOKEN_FILE: '/t', PWD: '/x' }

function wire(on: any) {
  mock.env(on, env)
  on('session.start', async () => ({ cwd: '/x' }))
  on('command.register', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('fs.read', async (_$: any, _e: any) => ({ value: 'tok' }))
  on('process.run', async (_$: any, _e: any) => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('http.fetch', async (_$: any, e: any) => {
    if (e.init?.method === 'POST') posts.push({ url: e.url, body: e.init.body })
    const text = e.url.endsWith('/children') ? JSON.stringify(kids) : e.url.endsWith('/inbox') ? '[]' : ''
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
}

async function mountPane($: any, on: any) {
  wire(on)
  const clock = mock.clock(on)
  await $.session.start({ source: 'startup', cwd: '/x' })
  await clock.advance(1000)
  return $.ui.mount({ plugin: 'orchestr8', surface: 'terminal', component: 'Pane', props: {}, requestId: 'o8-children', viewport: { columns: 48, rows: 40 } })
}

test('pane lists the self row first and shows a blocked row activity', async ($, on) => {
  const ui = await mountPane($, on)
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string)
  expect(texts.findIndex(t => t.includes('(you)'))).toBeLessThan(texts.findIndex(t => t.includes('[4cb2]')))
  expect(texts).toContain('Bash: rm -rf build')
  expect(texts).toContain('all green')
})

test('pressing a row button posts /focus', async ($, on) => {
  const ui = await mountPane($, on)
  await ui.press({ key: 'n-n-aaaa4cb2' })
  expect(posts.find(p => p.url.endsWith('/focus'))?.body).toBe(JSON.stringify({ id: 'n-aaaa4cb2' }))
})
