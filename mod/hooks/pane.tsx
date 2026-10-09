import type { Child } from '../types'
import { needsYou } from './notify'

// The elements come from $.ui.resolve(e); typed loosely because each surface has its own table.
export type Els = { Box: any; Text: any; Button: any }

const age = (s: number) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`)

/** Glyph, color and card border color by state; exited and errored win over what the state last said. */
export function look(c: Child): { glyph: string; color: string; bold?: boolean; dim?: boolean } {
  if (c.exited) return { glyph: '○', color: 'gray', dim: true }
  if (c.errored) return { glyph: '✗', color: 'red' }
  if (needsYou(c)) return { glyph: '!', color: 'yellow', bold: true }
  if (c.state === 'done') return { glyph: '✓', color: 'green' }
  if (c.state === 'working') return { glyph: '●', color: 'cyan' }
  return { glyph: '·', color: 'gray', dim: true }
}

/** The second card line: what the node is doing, the command it waits on, or what it last said. */
const detail = (c: Child) => (c.exited ? '' : c.state === 'done' ? c.lastMessage ?? '' : c.state === 'working' || needsYou(c) ? c.activity ?? '' : '')

export function Pane({ Box, Text, Button }: Els, list: Child[], focus: (c: Child) => void) {
  if (!list.length) return <Text dimColor>No nodes.</Text>
  let n = 0
  return (
    <Box flexDirection="column">
      <Box columnGap={1}>
        <Text bold>orchestr8</Text>
        <Text dimColor wrap="truncate-end">· {list[0]!.title} · {list.length} nodes · {list.filter(c => !c.self && needsYou(c)).length} need you</Text>
      </Box>
      {list.map(c => {
        const l = look(c)
        const sub = c.self ? '' : detail(c)
        const hotkey = !c.self && ++n <= 9 ? String(n) : undefined
        const title = c.self ? (
          <Text bold color="whiteBright" wrap="truncate-end">
            <Text color={l.color}>{l.glyph}</Text> {c.title} (you)
          </Text>
        ) : (
          <Button plain key={'n-' + c.id} hotkey={hotkey} onPress={() => focus(c)}>
            <Text color={l.color} bold={l.bold} dimColor={l.dim}>{l.glyph}</Text> {c.title}{c.unread ? ' •' : ''}
          </Button>
        )
        return (
          <Box key={c.id} flexDirection="column" borderStyle="round" borderColor={c.self ? 'whiteBright' : l.color} borderDimColor={!c.self && l.dim} marginLeft={2 * c.depth} paddingX={1}>
            <Box justifyContent="space-between">
              <Box columnGap={1}>
                {title}
                <Text dimColor>[{c.id.slice(-4)}]</Text>
              </Box>
              <Text dimColor>{age(c.ageSec)}</Text>
            </Box>
            {sub && <Text dimColor={!needsYou(c)} color={needsYou(c) ? 'yellow' : undefined} wrap="truncate-end">{sub}</Text>}
          </Box>
        )
      })}
    </Box>
  )
}
