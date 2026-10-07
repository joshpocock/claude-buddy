import { atom, read, update } from 'claude-code'

import { coldCost } from '../lib/mask.ts'
import type { AgentRow, Caught, Mood, Receipt } from '../../types'

// Buddy's shared state (same keys in every file, so every job sees the same values).
const agents = atom({ plugin: 'buddy', key: 'agents' } as const, [] as AgentRow[])
const caught = atom({ plugin: 'buddy', key: 'caught' } as const, { send: 0, spend: 0, danger: 0 } as Caught)
const memory = atom({ plugin: 'buddy', key: 'memory' } as const, 0)
const mood = atom({ plugin: 'buddy', key: 'mood' } as const, 'sleepy' as Mood)
const editing = atom({ plugin: 'buddy', key: 'editing' } as const, [] as string[])
const receipt = atom({ plugin: 'buddy', key: 'receipt' } as const, null as Receipt | null)
const lastTurnAt = atom({ plugin: 'buddy', key: 'lastTurnAt' } as const, 0)


// The all-chats board: each chat's Buddy keeps one small status file in ~/.claude/buddy/chats,
// and every Buddy reads them all. One file per chat, so chats never overwrite each other.
type ChatStatus = 'working' | 'waiting' | 'done' | 'idle' | 'closed'
type ChatRow = { id: string; title: string; folder: string; status: ChatStatus; since: number; updatedAt: number }

async function chatDir($: any): Promise<string> {
  const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.') as string
  return `${home.replace(/\\/g, '/')}/.claude/buddy/chats`
}

async function writeChat($: any, patch: Partial<ChatRow>) {
  const id = await $.session.id()
  const file = `${await chatDir($)}/${id}.json`
  let cur: Partial<ChatRow> = {}
  try {
    cur = JSON.parse(await $.fs.read(file))
  } catch {
    cur = {}
  }
  const now = Date.now()
  const next = { ...cur, ...patch, id, updatedAt: now } as ChatRow
  if (patch.status && patch.status !== cur.status) next.since = now
  if (!next.since) next.since = now
  await $.fs.write(file, JSON.stringify(next))
}

type Options = { agentWatcher?: boolean; donePingSeconds?: number; bannedPhrases?: string; cacheMinutes?: number; cacheAskAbove?: number }

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
    // Cache price check: after a break, the next message re-reads the whole chat at full price.
    // Buddy says what that costs and offers to compact first. Never blocks if anything fails.
    try {
      const live = ((await $.store.get('jobs')) ?? {}) as Record<string, boolean>
      const s = { ...options, ...(((await $.store.get('settings')) ?? {}) as Options) }
      const last = await read($, lastTurnAt)
      const ttl = Math.max(1, Number(s.cacheMinutes ?? 5)) * 60000
      const text = String(e.text ?? '').trim()
      if (live.cacheCheck !== false && e.origin?.kind === 'composer' && last > 0 && Date.now() - last > ttl && !text.startsWith('/')) {
        const usage = await $.session.usage()
        const tokens = Number(usage?.context?.tokens ?? 0)
        const model = String(await $.session.model())
        const { cold, warm } = coldCost(tokens, model, Number(s.cacheMinutes ?? 5))
        const askAbove = Number(s.cacheAskAbove ?? 0.5)
        if (tokens > 0 && cold >= askAbove) {
          const away = Math.round((Date.now() - last) / 60000)
          await update($, mood, () => 'holding')
          const choice = String(
            await $.ui.ask(
              `Buddy: your cache went cold ${away} min ago. This message re-reads your whole chat (${Math.round(tokens / 1000)}K tokens): about $${cold.toFixed(2)} at API rates, vs $${warm.toFixed(2)} warm. On a subscription it comes out of your limit instead. Compact first to shrink it? (Stop asking turns this check off; switch it back on in the Health card or Jobs.)`,
              ['Send anyway', 'Compact first, then send', 'Cancel', 'Stop asking'],
            ),
          )
          await update($, mood, () => 'working')
          const log = ((await $.store.get('log')) ?? []) as unknown[]
          await $.store.set('log', [{ at: Date.now(), kind: 'cache', what: `cold cache, ~$${cold.toFixed(2)}`, choice: choice.startsWith('Compact') ? 'Compacted first' : choice === 'Cancel' ? 'Cancelled' : choice === 'Stop asking' ? 'Turned the check off' : 'Sent anyway' }, ...log].slice(0, 20))
          if (choice === 'Stop asking') {
            await $.store.set('jobs', { ...live, cacheCheck: false })
            $.ui.toast('Buddy: cache price check OFF. Your message is going out. Switch it back on in the Health card.')
          }
          if (choice === 'Cancel') {
            await $.prompt.fill({ text })
            return { drop: 'Buddy kept your message in the box. Nothing was sent.' }
          }
          if (choice.startsWith('Compact')) {
            $.ui.toast('Buddy: compacting first...')
            await $.session.compact({})
          }
        }
      }
    } catch {
      // the price check is advice; a failure never blocks your message
    }
    await update($, mood, () => 'working')
    try {
      const text = String(e.text ?? '').replace(/\s+/g, ' ').trim()
      const file = `${await chatDir($)}/${await $.session.id()}.json`
      let title = ''
      try {
        title = JSON.parse(await $.fs.read(file)).title ?? ''
      } catch {
        title = ''
      }
      await writeChat($, { status: 'working', ...(title || !text || text.startsWith('/') ? {} : { title: short(text, 48) }) })
    } catch {
      // the board is a nice-to-have; never block a prompt over it
    }
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
    try {
      await writeChat($, { status: 'done' })
    } catch {
      // board only
    }
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
