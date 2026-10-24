// The agent's own send call as one transcript row. Display only: the tool call stays as it was.

/** The send call's result, from the JSON the daemon's MCP server returns as a text block; undefined while it runs or when unreadable. */
export function sendResult(output: unknown): { outcome: string; steer?: boolean } | undefined {
  const blocks = Array.isArray(output) ? output : [output]
  for (const b of blocks) {
    const text = typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : undefined
    try { const o = text && JSON.parse(text); if (typeof o?.outcome === 'string') return { outcome: o.outcome, steer: o.steer === true } } catch {}
  }
  return undefined
}

export function sentLine(input: unknown, output: unknown, isRunning: boolean, titles: { id: string; title: string }[]): string {
  const nodeId = (input as { nodeId?: unknown } | null)?.nodeId
  const id = typeof nodeId === 'string' ? nodeId : '?'
  const title = titles.find(c => c.id === id)?.title
  const r = isRunning ? { outcome: 'sending' } : sendResult(output)
  return `↗ message to ${title ? `${title} (${id})` : id}${r?.steer ? ' · steer' : ''}${r ? ` · ${r.outcome}` : ''}`
}
