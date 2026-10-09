export type Child = { title: string; state: 'working' | 'done' | 'blocked'; activity: string; ageSec: number; lastMessage: string }

declare module 'claude-code' {
  interface PluginState {
    'o8-mod': { children: Child[] }
  }
}
