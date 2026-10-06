import { atom, update } from 'claude-code'

import { classify, describeArgs, setExtraPaidHosts, toMeOnly } from '../lib/patterns.ts'
import type { Hit } from '../lib/patterns.ts'
import type { AgentRow, Caught, Mood } from '../../types'

// Buddy's shared state (same keys in every file, so every job sees the same values).
const caught = atom({ plugin: 'buddy', key: 'caught' } as const, { send: 0, spend: 0, danger: 0 } as Caught)
const lastHeld = atom({ plugin: 'buddy', key: 'lastHeld' } as const, '')
const mood = atom({ plugin: 'buddy', key: 'mood' } as const, 'sleepy' as Mood)

// The send gate, spend gate and danger guard share one tool.call hook.
// Each held call is answered through Buddy's own question, so it still asks when
// Claude Code runs with permissions bypassed. Anything that breaks denies (fail closed).

type Options = { myEmail?: string; sendGate?: boolean; spendGate?: boolean; dangerGuard?: boolean; paidApis?: string }

const today = () => new Date().toISOString().slice(0, 10)

const JOB_FOR: Record<Hit['kind'], 'sendGate' | 'spendGate' | 'dangerGuard'> = { send: 'sendGate', spend: 'spendGate', danger: 'dangerGuard' }

// A job is on unless the settings or the Jobs tab switched it off.
const enabled = (hit: Hit, o: Options, live: Record<string, boolean> | undefined) => {
  const job = JOB_FOR[hit.kind]
  if (live && live[job] !== undefined) return live[job]
  return (o as any)[job] !== false
}

const TITLES: Record<Hit['kind'], string> = {
  send: 'Buddy is holding something that would leave your machine.',
  spend: 'Buddy is holding a paid API call.',
  danger: 'Buddy is holding a command that can delete or overwrite work.',
}

type LogEntry = { at: number; kind: string; what: string; choice: string }
type Approvals = { date: string; targets: string[] }

// Buddy's activity log: the last 20 things he held and what you chose.
async function logEvent($: any, entry: LogEntry) {
  const log = ((await $.store.get('log')) ?? []) as LogEntry[]
  await $.store.set('log', [entry, ...log].slice(0, 20))
}

// "Approve all today" list, visible and undoable from the panel.
async function approvedToday($: any, target: string) {
  const a = ((await $.store.get('approvals')) ?? { date: '', targets: [] }) as Approvals
  return a.date === today() && a.targets.includes(target)
}

async function approveToday($: any, target: string) {
  const a = ((await $.store.get('approvals')) ?? { date: '', targets: [] }) as Approvals
  const targets = a.date === today() ? a.targets : []
  await $.store.set('approvals', { date: today(), targets: targets.includes(target) ? targets : [...targets, target] })
}

export function registerGuards(on: any, options: Options) {
  setExtraPaidHosts(options.paidApis)
  on('tool.call', async ($: any, e: any, next: any) => {
    // Settings saved in Buddy's panel win over the config file.
    const s = { ...options, ...(((await $.store.get('settings')) ?? {}) as Options) }
    setExtraPaidHosts(s.paidApis)
    const hit = classify(String(e.tool), e as Record<string, unknown>)
    if (!hit) return next(e)
    const live = (await $.store.get('jobs')) as Record<string, boolean> | undefined
    if (!enabled(hit, s, live)) return next(e)

    if (hit.kind !== 'danger' && (await approvedToday($, hit.target))) {
      await logEvent($, { at: Date.now(), kind: hit.kind, what: hit.what, choice: 'approved earlier today' })
      return next(e)
    }

    const detail = describeArgs(e as Record<string, unknown>)
    const summary = detail ? `${hit.what}. ${detail}` : hit.what
    await update($, lastHeld, () => `${hit.kind}: ${summary}`)
    await update($, mood, () => 'holding')

    const myEmail = (s.myEmail ?? '').trim()
    const choices =
      hit.kind === 'danger'
        ? ['Proceed', 'Cancel']
        : hit.kind === 'send' && hit.canSendToMe && myEmail
          ? ['Send', 'Send to me first', 'Approve all today', 'Cancel']
          : [hit.kind === 'send' ? 'Send' : 'Approve', 'Approve all today', 'Cancel']

    let answer = 'Cancel'
    try {
      answer = await $.ui.ask(`${TITLES[hit.kind]} ${summary}. Let it go?`, choices)
    } catch {
      answer = 'Cancel' // dismissed, nobody to ask, or anything broke: nothing goes out
    }
    await update($, mood, () => 'working')
    await logEvent($, { at: Date.now(), kind: hit.kind, what: summary.slice(0, 140), choice: answer.slice(0, 80) })

    if (answer === 'Send' || answer === 'Approve' || answer === 'Proceed') return next(e)
    if (answer === 'Approve all today') {
      await approveToday($, hit.target)
      return next(e)
    }
    if (answer === 'Send to me first') {
      const rewritten = toMeOnly(e as Record<string, unknown>, myEmail)
      if (!rewritten) return { deny: 'Buddy could not find a recipient to rewrite, so nothing was sent.' }
      await update($, lastHeld, () => `send: test copy to ${myEmail} only (${hit.what})`)
      await update($, caught, c => ({ ...c, send: c.send + 1 }))
      return next(rewritten)
    }

    await update($, caught, c => ({ ...c, [hit.kind]: c[hit.kind] + 1 }))
    if (answer !== 'Cancel') {
      return { deny: `Not sent. The user answered Buddy with: "${answer}". Do what they said, then ask again.` }
    }
    return { deny: `Cancelled by the user in Buddy's ${hit.kind} guard. Nothing happened.` }
  }).catch(($: any, e: any, next: any) => {
    // Fail closed for anything Buddy guards; every other tool carries on as normal.
    // When unsure whether a guard is on, treat it as on.
    const hit = classify(String(e.tool), e as Record<string, unknown>)
    return hit && enabled(hit, options, undefined) ? { deny: "Buddy's guard hit an error, so nothing was run or sent." } : next(e)
  })
}
