import type { Register } from 'claude-code'
import { parseEnvelope, receivedLine } from './envelope'

// A plugin of its own because the engine skips a plugin's hooks on a row its own $.prompt.submit made
// (debug log: "tiller@inline ui.render skipped: re-entry ... origin tiller"), so the tiller mod can never draw these rows.
export const register: Register = on => {
  // Messages take one dim line in the chat; ctrl+o (isExpanded) draws them in full. Display only: what the model read is unchanged.
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'plugin', name: 'tiller' } } }, async ($, e, next) => {
    const env = e.props.isExpanded ? undefined : parseEnvelope(e.props.text)
    if (!env) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor wrap="truncate-end">{receivedLine(env)}</Text>
  })
}
