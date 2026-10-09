import type { Child } from '../types'
import { needsYou } from './notify'
import type { Els } from './pane'

/** One line above the prompt. In a child (`parentId` set) the parent segment is a button that focuses it. */
export function Band({ Box, Text, Button }: Els, id: string, list: Child[], pending: number, parentId: string | undefined, focusParent: () => void) {
  const me = list.find(c => c.self)
  const first = list.find(c => !c.self && needsYou(c))
  const k = list.filter(c => !c.self && needsYou(c)).length
  return (
    <Box columnGap={1}>
      <Text dimColor wrap="truncate-end">orchestr8 · {me?.title ?? id} ·{parentId ? '' : ' parent none'}</Text>
      {parentId && <Button plain key="parent" onPress={focusParent}>↑ parent</Button>}
      {first && <Text color="yellow" wrap="truncate-end">· ! {first.title} [{first.id.slice(-4)}]{k > 1 ? ` +${k - 1}` : ''}</Text>}
      {pending > 0 && <Text dimColor>· {pending} pending</Text>}
    </Box>
  )
}
