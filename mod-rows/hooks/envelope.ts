// A received tiller message as one transcript row. Display only: the stored prompt stays as it was.
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
