import { describe, expect, test } from 'claude-code/testing'
import { parseEnvelope, receivedLine, sendResult, sentLine } from '../hooks/rows'

const msg = '--- TL MESSAGE Ab3_x-9Q ---\nfrom: Builder (n-3f2a)\nreply-to: n-3f2a\nplease rebase\nthen merge\n--- END TL MESSAGE Ab3_x-9Q ---'
const steered = msg.replace('reply-to: n-3f2a\n', 'reply-to: n-3f2a\nsteer: the sender interrupted your turn on purpose to deliver this now\n')

describe('envelope parsing', () => {
  test('a framed message parses', async () => {
    expect(parseEnvelope(msg)).toEqual({ from: 'Builder (n-3f2a)', replyTo: 'n-3f2a', steer: false, body: 'please rebase\nthen merge' })
    expect(receivedLine(parseEnvelope(msg)!)).toBe('↘ message from Builder (n-3f2a) · reply-to n-3f2a')
  })
  test('a steer line is not part of the body', async () => {
    expect(parseEnvelope(steered)).toMatchObject({ steer: true, body: 'please rebase\nthen merge' })
    expect(receivedLine(parseEnvelope(steered)!)).toBe('↘ message from Builder (n-3f2a) · steer · reply-to n-3f2a')
  })
  test('anything else is not an envelope', async () => {
    expect(parseEnvelope('hello')).toBeUndefined()
    expect(parseEnvelope(msg.replace('END TL MESSAGE Ab3_x-9Q', 'END TL MESSAGE other'))).toBeUndefined()
    expect(parseEnvelope(msg.replace('from: ', 'by: '))).toBeUndefined()
    expect(parseEnvelope(`note\n${msg}`)).toBeUndefined()
  })
})

describe('send rows', () => {
  const kids = [{ id: 'n-1', title: 'Worker' }]
  test('target title, steer and outcome', async () => {
    const out = [{ type: 'text', text: '{"outcome":"queued","messageId":"m1"}' }]
    expect(sentLine({ nodeId: 'n-1', text: 'x' }, out, false, kids)).toBe('↗ message to Worker (n-1) · queued')
    expect(sentLine({ nodeId: 'n-9', text: 'x', mode: 'now' }, undefined, true, kids)).toBe('↗ message to n-9 · sending')
    expect(sentLine({ nodeId: 'n-9', text: 'x', mode: 'now' }, '{"outcome":"queued","steer":true}', false, kids)).toBe('↗ message to n-9 · steer · queued')
  })
  test('outcome from a string result, none from unreadable output', async () => {
    expect(sendResult('{"outcome":"delivered"}')?.outcome).toBe('delivered')
    expect(sendResult('not json')).toBeUndefined()
    expect(sendResult(undefined)).toBeUndefined()
  })
})

// Mounts one transcript row; a hook that passes reaches the kit's empty bottom, so mount rejects and the row is the engine's.
async function row($: any, component: string, props: any) {
  try { return JSON.stringify(await (await $.ui.mount({ plugin: 'tiller', surface: 'terminal', component, props })).drawn()) } catch (err) {
    if (/no implementation for ui.render/.test(String(err))) return 'engine'
    throw err
  }
}

describe('render hooks', () => {
  const tiller = { kind: 'plugin', name: 'tiller', asUser: true }
  test('a tiller envelope is one line until expanded', async ($: any) => {
    expect(await row($, 'UserMessage', { text: steered, origin: tiller, isExpanded: false })).toContain('↘ message from Builder (n-3f2a) · steer · reply-to n-3f2a')
    expect(await row($, 'UserMessage', { text: msg, origin: tiller, isExpanded: true })).toBe('engine')
  })
  test('other rows are left alone', async ($: any) => {
    expect(await row($, 'UserMessage', { text: msg, origin: { kind: 'plugin', name: 'other', asUser: true }, isExpanded: false })).toBe('engine')
    expect(await row($, 'UserMessage', { text: msg, origin: { kind: 'composer' }, isExpanded: false })).toBe('engine')
    expect(await row($, 'UserMessage', { text: 'hi', origin: tiller, isExpanded: false })).toBe('engine')
    expect(await row($, 'ToolUse', { tool_use_id: 't', tool: 'Bash', input: {}, isRunning: false, isErrored: false, isInterrupted: false })).toBe('engine')
  })
  test('a send call is one line with its outcome; its result block is hidden until expanded', async ($: any) => {
    const output = [{ type: 'text', text: '{"outcome":"delivered"}' }]
    const use = { tool_use_id: 't', tool: 'mcp__tiller__send', input: { nodeId: 'n-1', text: 'x' }, isRunning: false, isErrored: false, isInterrupted: false, output }
    expect(await row($, 'ToolUse', use)).toContain('↗ message to n-1 · delivered')
    expect(await row($, 'ToolUse', { ...use, isExpanded: true })).toBe('engine')
    expect(await row($, 'ToolUse', { ...use, isErrored: true })).toBe('engine')
    expect(await row($, 'ToolResult', { tool_use_id: 't', tool: 'mcp__tiller__send', output, isErrored: false })).not.toBe('engine')
    expect(await row($, 'ToolResult', { tool_use_id: 't', tool: 'mcp__tiller__send', output, isErrored: false, isExpanded: true })).toBe('engine')
  })
})
