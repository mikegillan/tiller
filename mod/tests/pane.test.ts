import { expect, mock, test } from 'claude-code/testing'

// /tree as seen by "builder", a child of "boss": the root comes first and the caller's own row is in the middle.
const kids = [
  { id: 'n-root0001', title: 'boss', depth: 0, parentId: null, state: 'working', ageSec: 5, unread: false },
  { id: 'n-self0001', title: 'builder', depth: 1, self: true, parentId: 'n-root0001', state: 'working', ageSec: 5, unread: false },
  { id: 'n-aaaa4cb2', title: 'compiler', depth: 2, parentId: 'n-self0001', state: 'blocked', activity: 'Bash: rm -rf build', ageSec: 40, unread: true },
  { id: 'n-bbbb0002', title: 'tester', depth: 1, parentId: 'n-root0001', state: 'done', lastMessage: 'all green', ageSec: 200, unread: false },
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
    const text = e.url.endsWith('/tree') ? JSON.stringify(kids) : e.url.endsWith('/inbox') ? '[]' : ''
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
}

async function mountPane($: any, on: any) {
  posts.length = 0
  wire(on)
  const clock = mock.clock(on)
  await $.session.start({ source: 'startup', cwd: '/x' })
  await clock.advance(1000)
  return $.ui.mount({ plugin: 'orchestr8', surface: 'terminal', component: 'Pane', props: {}, requestId: 'o8-children', viewport: { columns: 48, rows: 40 } })
}

test('pane shows the whole tree: root first, the caller marked (you) and not first, blocked activity', async ($, on) => {
  const ui = await mountPane($, on)
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string)
  expect(texts.some(t => t.includes('· boss · 4 nodes · 1 need you'))).toBe(true)
  const at = (s: string) => texts.findIndex(t => t.includes(s))
  expect(at('boss')).toBeGreaterThanOrEqual(0)
  expect(at('(you)')).toBeGreaterThan(at('[0001]'))
  expect(at('(you)')).toBeLessThan(at('[4cb2]'))
  expect(texts).toContain('Bash: rm -rf build')
  expect(texts).toContain('all green')
})

test('pressing the root card posts /focus with the root id', async ($, on) => {
  const ui = await mountPane($, on)
  await ui.press({ key: 'n-n-root0001' })
  expect(posts.find(p => p.url.endsWith('/focus'))?.body).toBe(JSON.stringify({ id: 'n-root0001' }))
})

test('pressing a row button posts /focus', async ($, on) => {
  const ui = await mountPane($, on)
  await ui.press({ key: 'n-n-aaaa4cb2' })
  expect(posts.find(p => p.url.endsWith('/focus'))?.body).toBe(JSON.stringify({ id: 'n-aaaa4cb2' }))
})
