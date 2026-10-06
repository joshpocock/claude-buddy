export type Mood = 'sleepy' | 'working' | 'happy' | 'holding' | 'tired'
export type AgentRow = { id: string; task: string; startedAt: number; endedAt?: number }
export type Caught = { send: number; spend: number; danger: number }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Receipt = { files: string[]; seconds: number; at: number }

declare module 'claude-code' {
  interface PluginState {
    buddy: {
      mood: Mood
      memory: number
      agents: AgentRow[]
      tick: number
      lastHeld: string
      caught: Caught
      limits: Limit[]
      cost: number
      editing: string[]
      receipt: Receipt | null
      codexLog: string[]
      codexStatus: string
      tab: 'status' | 'chats' | 'jobs' | 'pets' | 'settings' | 'help'
      recOn: boolean
      lastTurnAt: number
    }
  }
}
