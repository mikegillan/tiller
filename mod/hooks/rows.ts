// One-line transcript rows for tiller messages. Display only: the stored prompt and the tool call stay as they were.
export type Envelope = { from: string; replyTo: string; steer: boolean }
const STEER = 'steer: the sender interrupted your turn on purpose to deliver this now'

/** The daemon's frame (src/daemon/messaging.ts frame()): start and end lines with the same nonce, then from, reply-to and the steer line when there is one. */
export function parseEnvelope(text: string): Envelope | undefined {
  const lines = text.replace(/\s+$/, '').split(/\r?\n/)
  const nonce = /^--- TL MESSAGE (\S+) ---$/.exec(lines[0] ?? '')?.[1]
  if (!nonce || lines.length < 4 || lines[lines.length - 1] !== `--- END TL MESSAGE ${nonce} ---`) return undefined
  const from = /^from: (.*)$/.exec(lines[1])?.[1], replyTo = /^reply-to: (.*)$/.exec(lines[2])?.[1]
  if (from === undefined || replyTo === undefined) return undefined
  return { from, replyTo, steer: lines[3] === STEER }
}

export function receivedLine(e: Envelope): string {
  return `↘ message from ${e.from}${e.steer ? ' · steer' : ''} · reply-to ${e.replyTo}`
}

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
