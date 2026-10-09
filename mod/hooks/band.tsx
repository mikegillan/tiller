import type { Child } from '../types'
import { needsYou } from './notify'
import type { Els } from './pane'

/** One line above the prompt. In a child the parent (and, when different, the root) is a button that focuses it. `placed` is whether the tree pane is open. */
export function Band({ Box, Text, Button }: Els, id: string, list: Child[], pending: number, parentId: string | undefined, placed: boolean, focus: (id: string, label: string) => void) {
  const rootId = list[0] && !list[0].self ? list[0].id : undefined
  const me = list.find(c => c.self)
  const first = list.find(c => !c.self && needsYou(c))
  const k = list.filter(c => !c.self && needsYou(c)).length
  return (
    <Box columnGap={1}>
      <Text dimColor wrap="truncate-end">orchestr8 · {me?.title ?? id} ·{parentId ? '' : ' parent none'}</Text>
      {parentId && <Button plain key="parent" onPress={() => focus(parentId, 'parent')}>↑ parent</Button>}
      {rootId && rootId !== parentId && <Button plain key="root" onPress={() => focus(rootId, 'root')}>⌂ root</Button>}
      {!placed && <Text dimColor>· /o8 for tree</Text>}
      {first && <Text color="yellow" wrap="truncate-end">· ! {first.title} [{first.id.slice(-4)}]{k > 1 ? ` +${k - 1}` : ''}</Text>}
      {pending > 0 && <Text dimColor>· {pending} pending</Text>}
    </Box>
  )
}
