export const COMMANDS: [string, string][] = [
  ['tl-list', 'List tiller nodes'],
  ['tl-spawn', 'Spawn a child: <title> :: <prompt>'], ['tl-send', 'Send a message: <nodeId> <text>'],
  ['tl-read', 'Read a node summary: <nodeId>'],
]

export const parseSpawn = (args: string) => {
  const [title, prompt] = args.split('::').map(s => s.trim())
  return title ? { title, prompt: prompt || undefined } : undefined
}

export const parseSend = (args: string) => {
  const [nodeId, ...text] = args.trim().split(/\s+/)
  return nodeId && text.length ? { nodeId, text: text.join(' ') } : undefined
}
