import type { Child } from '../types'
import { needsYou } from './notify'
export type Els = { Box: any; Text: any; Button: any }

/** One line above the prompt. In a child the parent (and, when different, the root) is a button that focuses it. */
export function Band({ Box, Text, Button }: Els, id: string, list: Child[], pending: number, parentId: string | undefined, focus: (id: string, label: string) => void) {
  const rootId = list[0] && !list[0].self ? list[0].id : undefined
  const me = list.find(c => c.self)
  const needy = list.filter(c => !c.self && needsYou(c))
  const first = needy[0], k = needy.length
  return (
    <Box columnGap={1}>
      <Text dimColor wrap="truncate-end">tiller · {me?.title ?? id} ·{parentId ? '' : ' parent none'}</Text>
      {parentId && <Button plain key="parent" onPress={() => focus(parentId, 'parent')}>↑ parent</Button>}
      {rootId && rootId !== parentId && <Button plain key="root" onPress={() => focus(rootId, 'root')}>⌂ root</Button>}
      {first && <Text color="yellow" wrap="truncate-end">· ! {first.title} [{first.id.slice(-4)}]{k > 1 ? ` +${k - 1}` : ''}</Text>}
      {pending > 0 && <Text dimColor>· {pending} pending</Text>}
    </Box>
  )
}
