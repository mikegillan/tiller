export type Child = {
  id: string; title: string; depth: number; state: string; activity?: string
  ageSec: number; lastMessage?: string; unread: boolean; errored?: boolean; exited?: boolean
  self?: boolean; parentId?: string | null
  git?: { branch: string; base: string; ahead: number; behind: number; dirty: number; missing?: boolean; mergedAt?: number }
}

declare module 'claude-code' {
  interface PluginState {
    orchestr8: { children: Child[]; pending: number; quiet: boolean }
  }
}
