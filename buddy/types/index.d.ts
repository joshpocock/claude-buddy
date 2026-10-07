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
      tab: 'status' | 'chats' | 'threads' | 'skills' | 'jobs' | 'pets' | 'settings' | 'help'
      skillScan: { at: number; cwd: string; items: { name: string; scope: 'global' | 'project'; path: string; isLink: boolean; descChars: number; description: string }[]; codexLink: boolean } | null
      skillView: { q: string; sort: 'used' | 'unused' | 'big'; shown: number; open: string }
      agentLive: Record<string, { tool?: string; steps: number; lastAt: number }>
      chatThreads: { id: string; sessionId?: string; task: string; model: string; by: string; status: 'starting' | 'running' | 'done' | 'failed'; startedAt: number; endedAt?: number; lastTool?: string; answer?: string; turns: number }[]
      threadModel: string
      threadKind: 'helper' | 'chat'
      peek: { id: string; text: string } | null
      recOn: boolean
      lastTurnAt: number
    }
  }
}
