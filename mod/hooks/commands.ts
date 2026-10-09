export const COMMANDS: [string, string][] = [
  ['o8-list', 'List orchestr8 nodes'],
  ['o8-spawn', 'Spawn a child: <title> :: <prompt>'], ['o8-send', 'Send a message: <nodeId> <text>'],
  ['o8-read', 'Read a node summary: <nodeId>'],
]

export const parseSpawn = (args: string) => {
  const [title, prompt] = args.split('::').map(s => s.trim())
  return title ? { title, prompt: prompt || undefined } : undefined
}

export const parseSend = (args: string) => {
  const [nodeId, ...text] = args.trim().split(/\s+/)
  return nodeId && text.length ? { nodeId, text: text.join(' ') } : undefined
}
