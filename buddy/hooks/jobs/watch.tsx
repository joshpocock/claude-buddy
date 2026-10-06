import { atom, read, update } from 'claude-code'

import type { AgentRow, Caught, Mood, Receipt } from '../../types'

// Buddy's shared state (same keys in every file, so every job sees the same values).
const agents = atom({ plugin: 'buddy', key: 'agents' } as const, [] as AgentRow[])
const caught = atom({ plugin: 'buddy', key: 'caught' } as const, { send: 0, spend: 0, danger: 0 } as Caught)
const memory = atom({ plugin: 'buddy', key: 'memory' } as const, 0)
const mood = atom({ plugin: 'buddy', key: 'mood' } as const, 'sleepy' as Mood)
const editing = atom({ plugin: 'buddy', key: 'editing' } as const, [] as string[])
const receipt = atom({ plugin: 'buddy', key: 'receipt' } as const, null as Receipt | null)
const lastTurnAt = atom({ plugin: 'buddy', key: 'lastTurnAt' } as const, 0)

type Options = { agentWatcher?: boolean; donePingSeconds?: number; bannedPhrases?: string }

const short = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + '…' : text)

// Reads how full the chat is and keeps Buddy's face in step with it.
export async function readMemory($: any) {
  const usage = await $.session.usage()
  const context = usage?.context
  if (!context || !context.window) return
  const tokens = context.tokens ?? 0
  const percent = Math.round(context.percent ?? (tokens / context.window) * 100)
  await update($, memory, () => percent)
}

export function registerWatch(on: any, options: Options) {
  on('prompt.submit', async ($: any, e: any, next: any) => {
    await update($, mood, () => 'working')
    return next(e)
  })

  on('turn.complete', async ($: any, e: any, next: any) => {
    const done = await next(e)
    if (e.agentId !== undefined) {
      const now = await $.clock.now()
      await update($, agents, (list: AgentRow[]) =>
        list.map(row => (row.id === e.agentId && row.endedAt === undefined ? { ...row, endedAt: now } : row)),
      )
      return done
    }
    await readMemory($)
    await update($, mood, () => 'happy')
    await update($, lastTurnAt, () => Date.now())
    const live = ((await $.store.get('jobs')) ?? {}) as Record<string, boolean>
    // Work receipt: the files this task changed.
    const files = await read($, editing)
    const seconds = Math.round(Number(e.durationMs ?? 0) / 1000)
    if (files.length > 0) {
      const at = await $.clock.now()
      await update($, receipt, () => ({ files, seconds, at }))
      await update($, editing, () => [])
    }
    // Done ping for long tasks, so you can walk away.
    const s = { ...options, ...(((await $.store.get('settings')) ?? {}) as Options) }
    const pingAfter = Number(s.donePingSeconds ?? 60)
    if (live.donePing !== false && !e.isAborted && pingAfter > 0 && seconds >= pingAfter) {
      const took = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      $.ui.toast(`( ^.^ )/ Buddy: done in ${took}${files.length ? `, ${files.length} file${files.length === 1 ? '' : 's'} changed` : ''}`)
    }
    // House rules check: flag banned words in the reply.
    const banned = (s.bannedPhrases ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const answer = String(e.answer ?? '')
    const hits = banned.filter(b => answer.toLowerCase().includes(b.toLowerCase()))
    if (live.houseRules !== false && hits.length > 0) $.ui.toast(`Buddy: that reply used ${hits.map(h => `"${h}"`).join(', ')}, which your house rules ban`)
    // Keep the lifetime caught counter between sessions.
    await $.store.set('caught', await read($, caught))
    return done
  })

  if (options.agentWatcher !== false) {
    on('agent.spawn', async ($: any, e: any, next: any) => {
      const started = await next(e)
      const live = ((await $.store.get('jobs')) ?? {}) as Record<string, boolean>
      if (live.agentWatcher !== false && started?.agentId !== undefined) {
        const now = await $.clock.now()
        const row: AgentRow = { id: started.agentId, task: short(String(e.description ?? e.prompt ?? 'agent'), 44), startedAt: now }
        await update($, agents, (list: AgentRow[]) => [...list, row].slice(-10))
      }
      return started
    })
  }
}
