import { describe, expect, test } from 'claude-code/testing'
import { sendResult, sentLine } from '../hooks/rows'

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
  test('rows other than a send call are left alone', async ($: any) => {
    expect(await row($, 'ToolUse', { tool_use_id: 't', tool: 'Bash', input: {}, isRunning: false, isErrored: false, isInterrupted: false, isExpanded: false })).toBe('engine')
  })
  // The shape Claude Code 2.1.310 passed for a send call, logged live (there with isExpanded true: ctrl+o).
  test('a send call is one line with its outcome; its result block is empty until expanded', async ($: any) => {
    const output = [{ type: 'text', text: '{"outcome":"delivered","messageId":"m1"}' }]
    const use = { tool_use_id: 't', tool: 'mcp__tiller__send', input: { nodeId: 'n-1', text: 'x' }, isRunning: false, isErrored: false, isInterrupted: false, isExpanded: false, output }
    expect(await row($, 'ToolUse', use)).toContain('↗ message to n-1 · delivered')
    expect(await row($, 'ToolUse', { ...use, isExpanded: true })).toBe('engine')
    expect(await row($, 'ToolUse', { ...use, isExpanded: undefined })).toBe('engine')
    expect(await row($, 'ToolUse', { ...use, isErrored: true })).toBe('engine')
    const result = { tool_use_id: 't', tool: 'mcp__tiller__send', output, isErrored: false, isExpanded: false }
    expect(JSON.parse(await row($, 'ToolResult', result))).toEqual({ type: 'Box', part: { plugin: 'tiller' } }) // no children: nothing drawn
    expect(await row($, 'ToolResult', { ...result, isExpanded: true })).toBe('engine')
    expect(await row($, 'ToolResult', { ...result, isExpanded: undefined })).toBe('engine')
  })
  test('a failed send keeps its result block', async ($: any) => {
    const result = { tool_use_id: 't', tool: 'mcp__tiller__send', isExpanded: false }
    expect(await row($, 'ToolResult', { ...result, output: 'error: boom', isErrored: true })).toBe('engine')
    expect(await row($, 'ToolResult', { ...result, output: [{ type: 'text', text: '{"outcome":"refused","detail":"out of scope"}' }], isErrored: false })).toBe('engine')
  })
})
