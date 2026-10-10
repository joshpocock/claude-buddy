import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { registerExtras } from './jobs/extras.tsx'
import { registerGuards } from './jobs/guards.tsx'
import { registerPower } from './jobs/power.tsx'
import { registerThreads } from './jobs/threads.tsx'
import { frontmatter, norm, registerSkills } from './jobs/skills.tsx'
import { registerCodexTeam } from './jobs/codexteam.tsx'
import type { CodexJob } from './jobs/codexteam.tsx'
import { dayDirs, dumpArgv, idFromFile, parseDump, parseIndex } from './lib/codexthreads.ts'
import type { CodexThread } from './lib/codexthreads.ts'
import type { SkillItem, SkillScan, SkillUse } from './jobs/skills.tsx'
import type { AgentLive, ChatThread } from './jobs/threads.tsx'
import type { Todo } from './jobs/power.tsx'
import { maskText, nameList } from './lib/mask.ts'
import { registerWatch } from './jobs/watch.tsx'
import type { AgentRow, Caught, Limit, Mood, Receipt } from '../types'

// Buddy's shared state (same keys in every file, so every job sees the same values).
const agents = atom({ plugin: 'buddy', key: 'agents' } as const, [] as AgentRow[])
const caught = atom({ plugin: 'buddy', key: 'caught' } as const, { send: 0, spend: 0, danger: 0 } as Caught)
const lastHeld = atom({ plugin: 'buddy', key: 'lastHeld' } as const, '')
const memory = atom({ plugin: 'buddy', key: 'memory' } as const, 0)
const mood = atom({ plugin: 'buddy', key: 'mood' } as const, 'sleepy' as Mood)
const tick = atom({ plugin: 'buddy', key: 'tick' } as const, 0)
const limits = atom({ plugin: 'buddy', key: 'limits' } as const, [] as Limit[])
const cost = atom({ plugin: 'buddy', key: 'cost' } as const, 0)
const receipt = atom({ plugin: 'buddy', key: 'receipt' } as const, null as Receipt | null)
const codexLog = atom({ plugin: 'buddy', key: 'codexLog' } as const, [] as string[])
const codexStatus = atom({ plugin: 'buddy', key: 'codexStatus' } as const, '')
const tab = atom({ plugin: 'buddy', key: 'tab' } as const, 'status' as 'status' | 'chats' | 'threads' | 'codex' | 'skills' | 'jobs' | 'pets' | 'settings' | 'help')

// The pets Buddy can be. A new install starts as an egg that hatches into a random one.
const SPECIES = ['bunny', 'cat', 'dog', 'bear', 'frog', 'owl', 'ghost', 'dragon'] as const
type PetInfo = { stage: 'egg' | 'pet'; species: (typeof SPECIES)[number]; name: string; pets: number }
const NEW_PET: PetInfo = { stage: 'egg', species: 'bunny', name: 'Buddy', pets: 0 }
const lastTurnAt = atom({ plugin: 'buddy', key: 'lastTurnAt' } as const, 0)
const recOn = atom({ plugin: 'buddy', key: 'recOn' } as const, false)
const agentLive = atom({ plugin: 'buddy', key: 'agentLive' } as const, {} as Record<string, AgentLive>)
const chatThreads = atom({ plugin: 'buddy', key: 'chatThreads' } as const, [] as ChatThread[])
const threadModel = atom({ plugin: 'buddy', key: 'threadModel' } as const, 'sonnet')
const threadKind = atom({ plugin: 'buddy', key: 'threadKind' } as const, 'helper' as 'helper' | 'chat')
const forecast = atom({ plugin: 'buddy', key: 'forecast' } as const, { limits: {}, repliesLeft: null } as { limits: Record<string, { fullAt?: number; resetsAt?: string }>; repliesLeft: number | null })
const codexJobs = atom({ plugin: 'buddy', key: 'codexJobs' } as const, [] as CodexJob[])
const cxThreads = atom({ plugin: 'buddy', key: 'cxThreads' } as const, null as CodexThread[] | null)
const cxEdit = atom({ plugin: 'buddy', key: 'cxEdit' } as const, false)
const skillScan = atom({ plugin: 'buddy', key: 'skillScan' } as const, null as SkillScan | null)
const skillView = atom({ plugin: 'buddy', key: 'skillView' } as const, { q: '', sort: 'used' as 'used' | 'unused' | 'big', shown: 15, open: '' })
const peek = atom({ plugin: 'buddy', key: 'peek' } as const, null as { id: string; text: string } | null)

// Buddy: Claude Code's old pet, back with real jobs.
// Jobs live in ./jobs; this file draws Buddy and wires the jobs in.


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

const PANE = 'buddy'

// Statuses seen last time, so Buddy can ping you when another chat finishes or needs you.
const seenStatus: Record<string, ChatStatus> = {}
let selfId = ''
// The reply Buddy already warned about, so the 'cache going cold' ping fires once.
let warnedTurn = 0

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`
}

async function readChats($: any): Promise<ChatRow[]> {
  const dir = await chatDir($)
  if (!(await $.fs.exists(dir))) return []
  const entries = await $.fs.list(dir)
  const rows: ChatRow[] = []
  for (const ent of entries) {
    if (ent.kind !== 'file' || !ent.name.endsWith('.json')) continue
    try {
      const row = JSON.parse(await $.fs.read(`${dir}/${ent.name}`)) as ChatRow
      // A chat that stopped checking in for 3 minutes is gone (closed or crashed).
      if (row.status !== 'closed' && Date.now() - row.updatedAt < 180000) rows.push(row)
    } catch {
      // skip unreadable files
    }
  }
  const rank: Record<string, number> = { waiting: 0, working: 1, done: 2, idle: 3 }
  return rows.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.since - a.since)
}


async function scanCodexForPanel($: any) {
  const home = (((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.') as string).replace(/\\/g, '/')
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const files: { path: string; id: string; mtime: number }[] = []
  for (const dir of dayDirs(home, 14)) {
    if (!(await $.fs.exists(dir))) continue
    for (const ent of await $.fs.list(dir)) {
      const id = idFromFile(ent.name)
      if (ent.kind === 'file' && id) files.push({ path: `${dir}/${ent.name}`, id, mtime: ent.mtimeMs })
    }
  }
  const recent = files.sort((a, b) => b.mtime - a.mtime).slice(0, 15)
  if (recent.length === 0) {
    await update($, cxThreads, () => [])
    return
  }
  let names: Record<string, string> = {}
  try {
    names = parseIndex(await $.fs.read(`${home}/.codex/session_index.jsonl`))
  } catch {
    names = {}
  }
  try {
    const r = await $.process.run(dumpArgv(windows, recent.map(f => f.path)), { timeoutMs: 60000 })
    await update($, cxThreads, () => parseDump(String(r.stdout ?? ''), names, Object.fromEntries(recent.map(f => [f.id, f.mtime]))))
  } catch {
    await update($, cxThreads, () => [])
  }
}

async function scanSkillDir($: any, dir: string, scope: 'global' | 'project'): Promise<SkillItem[]> {
  if (!(await $.fs.exists(dir))) return []
  const out: SkillItem[] = []
  for (const ent of await $.fs.list(dir)) {
    if (ent.name.startsWith('.') || (ent.kind !== 'dir' && !ent.isLink)) continue
    const path = `${dir}/${ent.name}`
    let text = ''
    try {
      text = await $.fs.read(`${path}/SKILL.md`)
    } catch {
      continue
    }
    const fm = frontmatter(text)
    const name = fm.name || ent.name
    out.push({ name, scope, path, isLink: Boolean(ent.isLink), descChars: fm.description.length + name.length, description: fm.description.slice(0, 220) })
  }
  return out
}

async function scanAllSkills($: any) {
  const home = norm(((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.') as string)
  const cwd = norm(await $.session.cwd())
  const global = await scanSkillDir($, `${home}/.claude/skills`, 'global')
  const project = cwd === home ? [] : await scanSkillDir($, `${cwd}/.claude/skills`, 'project')
  const codexLink = await $.fs.exists(`${cwd}/.agents/skills`)
  await update($, skillScan, () => ({ at: Date.now(), cwd, items: [...project, ...global], codexLink }))
}

const FACES: Record<Mood, [string, string]> = {
  sleepy: ['( -.- ) zz', 'waiting on you'],
  working: ['( o.o )', 'on it'],
  happy: ['( ^.^ )/', 'done!'],
  holding: ['( O.O )!', 'holding something for you'],
  tired: ['( x_x )', "I'm full. Time to compact."],
}

const faceFor = (m: Mood, mem: number): [string, string] => (m !== 'holding' && mem >= 80 ? FACES.tired : FACES[m])

const bar = (percent: number, width = 12) => {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const tone = (percent: number) => (percent >= 80 ? 'red' : percent >= 50 ? 'yellow' : 'green')

const elapsed = (row: AgentRow, now: number) => {
  const s = Math.max(0, Math.round(((row.endedAt ?? now) - row.startedAt) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

const total = (c: Caught) => c.send + c.spend + c.danger

const baseName = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p

// Every job Buddy does, for the Jobs and Help tabs. `live` jobs switch instantly from the panel.
const JOBS: { id: string; group: string; name: string; what: string; live: boolean }[] = [
  { id: 'sendGate', group: 'Guards', name: 'Send gate', what: 'Holds emails, Slack, invites, shares, git push, deploys and posts to outside APIs until you choose', live: true },
  { id: 'spendGate', group: 'Guards', name: 'Spend gate', what: 'Holds paid API calls (OpenAI, Anthropic, Gemini, ElevenLabs, Replicate, fal, Apify and any you add in settings)', live: true },
  { id: 'dangerGuard', group: 'Guards', name: 'Danger guard', what: 'Holds deletes, wipes, force pushes and database drops (Bash and PowerShell)', live: true },
  { id: 'lockedFiles', group: 'Guards', name: 'Locked files', what: 'Claude cannot edit the files you lock in settings (.env by default)', live: true },
  { id: 'chatBoard', group: 'Watches', name: 'Chats board', what: 'Shows every open Claude Code chat and pings you when one finishes or needs you', live: true },
  { id: 'cacheCheck', group: 'Watches', name: 'Cache price check', what: 'After a break, tells you what your next message costs (the cache went cold) and offers to compact first', live: true },
  { id: 'agentWatcher', group: 'Watches', name: 'Agent watcher', what: 'Lists every helper agent, running or done, with times', live: true },
  { id: 'donePing', group: 'Watches', name: 'Done ping', what: 'Pops up when a long task finishes, so you can walk away', live: true },
  { id: 'todoInbox', group: 'Helps', name: 'To-do inbox', what: 'When Claude needs you (add a key, log in, approve), it lands on your to-do list. Press Done and Claude carries on', live: true },
  { id: 'houseRules', group: 'Helps', name: 'House rules', what: 'Reminds Claude of your rules and flags banned words in replies', live: true },
  { id: 'codex', group: 'Helps', name: 'Codex sidekick', what: 'Ask Codex for a read-only second opinion: /codex <task>. Turn on in settings (sends the task to OpenAI)', live: false },
]

const LIMIT_NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly', '5h': '5-hour', '7d': 'weekly' }

export const register: Register = (on, options) => {
  const o = options as any
  registerGuards(on, o)
  registerWatch(on, o)
  registerExtras(on, o)
  registerPower(on, o)
  registerThreads(on, o)
  registerSkills(on)
  registerCodexTeam(on, o)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'buddy', description: 'Open Buddy: your pet who watches and guards Claude' })
    await $.command.register({ name: 'handoff', description: 'Buddy writes a handoff note for continuing in a fresh chat' })
    const panel = ((await $.store.get('settings')) ?? {}) as Record<string, unknown>
    await $.command.register({ name: 'codex', description: 'Ask Codex (read-only) for a second opinion: /codex <task>' })
    if (o.codexEnabled === true || panel.codexEnabled === true) {
      await $.tool.register({
        name: 'codex',
        description:
          'Ask OpenAI Codex (a second, independent coding agent) for a read-only second opinion or review. Give it one clear, self-contained task. It cannot edit files. Returns its answer.',
        inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
      })
    }
    await $.tool.register({
      name: 'todo_for_you',
      description:
        "Put a task on the user's Buddy to-do list: something only they can do (add an API key, log in, approve or pay, check something by hand, decide). The user presses Done when finished and you get a message. One task per call.",
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'One short sentence starting with a verb, e.g. "Add your OpenAI key to .env"' },
          doneWhen: { type: 'string', description: 'Optional: how the user knows it is done' },
        },
        required: ['task'],
      },
    })
    if ((await $.env.get('BUDDY_CHILD')) !== '1') {
      await $.command.register({ name: 'buddy-codex', description: 'Buddy: start or message Codex agents (the Codex tab uses this)' })
      await $.tool.register({
        name: 'codex_threads',
        description: "List the user's recent OpenAI Codex threads (from the Codex app and CLI: id, name, folder, working or idle, last reply) and the Codex agents started from this chat.",
        inputSchema: { type: 'object', properties: {} },
      })
      await $.tool.register({
        name: 'codex_start',
        description:
          'Start an OpenAI Codex agent on a self-contained task (a second AI working in parallel: research, review, a separate build). Read-only unless canEdit is true, which asks the user first. Returns at once and the answer arrives later as a message from Buddy; set wait to true to wait for the answer instead.',
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Complete instructions; Codex sees nothing of this chat' },
            model: { type: 'string', description: 'Codex model, default from Buddy settings (gpt-5.5)' },
            canEdit: { type: 'boolean', description: 'Let Codex edit files in this project (the user is asked)' },
            wait: { type: 'boolean', description: 'Wait for the answer instead of getting it later' },
          },
          required: ['task'],
        },
      })
      await $.tool.register({
        name: 'codex_message',
        description:
          "Send the next message to a Codex thread or agent (a thread id from codex_threads, or an agent id from codex_start). Codex continues that conversation with its memory. Don't message a thread that is working.",
        inputSchema: {
          type: 'object',
          properties: { threadId: { type: 'string' }, text: { type: 'string' }, wait: { type: 'boolean' } },
          required: ['threadId', 'text'],
        },
      })
      await $.command.register({ name: 'buddy-skills', description: 'Buddy: scan, copy, move or delete skills (the Skills tab uses this)' })
      await $.command.register({ name: 'thread', description: 'Buddy: start a separate background chat: /thread <task>' })
      await $.tool.register({
        name: 'list_chats',
        description: "List the user's other open Claude Code chats (id, title, folder, status: working, waiting, done, idle) and the separate background chats started from this one, with their answers.",
        inputSchema: { type: 'object', properties: {} },
      })
      await $.tool.register({
        name: 'message_chat',
        description:
          'Send a message to another open Claude Code chat (chatId from list_chats) or to a separate chat started with start_chat (its id). Use it to hand work to another chat or to steer it.',
        inputSchema: { type: 'object', properties: { chatId: { type: 'string' }, text: { type: 'string' } }, required: ['chatId', 'text'] },
      })
      await $.tool.register({
        name: 'start_chat',
        description:
          'Start a separate Claude Code chat in the background with its own model and a self-contained task, so several jobs run in parallel as independent threads. Returns at once; the answer arrives later as a message from Buddy. For quick side tasks inside this chat, use a background subagent instead.',
        inputSchema: {
          type: 'object',
          properties: { task: { type: 'string', description: 'Complete, self-contained instructions' }, model: { type: 'string', description: 'sonnet, opus or fable (default sonnet)' } },
          required: ['task'],
        },
      })
    }
    const recSaved = (await $.store.get('rec')) === true
    await update($, recOn, () => recSaved)
    // Lifetime caught counter, kept between sessions.
    const saved = (await $.store.get('caught')) as Caught | undefined
    if (saved) await update($, caught, () => saved)
    // First memory reading, so Buddy's face is right before the first turn.
    const usage = await $.session.usage()
    if (usage?.context?.window) {
      const pct = Math.round(usage.context.percent ?? ((usage.context.tokens ?? 0) / usage.context.window) * 100)
      await update($, memory, () => pct)
    }
    // Redraw once a second so agent timers move.
    $.clock.every(1000, () => update($, tick, n => n + 1))
    // Join the all-chats board, check in every 20s, and ping when another chat needs you.
    try {
      selfId = await $.session.id()
      const folder = String(e.cwd ?? '').replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? ''
      await writeChat($, { status: 'idle', folder })
    } catch {
      // board only
    }
    $.clock.every(20000, async () => {
      try {
        // Recording mode is shared: switching it in one chat masks every chat within 20s.
        const recNow = (await $.store.get('rec')) === true
        if (recNow !== (await read($, recOn))) await update($, recOn, () => recNow)
        await writeChat($, {})
        const live = ((await $.store.get('jobs')) ?? {}) as Record<string, boolean>
        // About a minute before the cache goes cold, say so, once per reply.
        const last = await read($, lastTurnAt)
        const panel = ((await $.store.get('settings')) ?? {}) as Record<string, unknown>
        const ttl = Math.max(1, Number(panel.cacheMinutes ?? o.cacheMinutes ?? 60)) * 60000
        const left = last + ttl - Date.now()
        if (live.cacheCheck !== false && last > 0 && last !== warnedTurn && left > 0 && left <= 70000) {
          warnedTurn = last
          $.ui.toast('Buddy: your cache goes cold in about a minute. Send your next message now to keep it cheap.')
        }
        for (const row of await readChats($)) {
          const before = seenStatus[row.id]
          seenStatus[row.id] = row.status
          if (row.id === selfId || before === undefined || before === row.status || live.chatBoard === false) continue
          const name = row.title || row.folder || 'another chat'
          if (row.status === 'waiting') $.ui.toast(`Buddy: "${name}" is waiting on you`)
          else if (row.status === 'done' && before === 'working') $.ui.toast(`Buddy: "${name}" just finished`)
        }
      } catch {
        // board only
      }
    })
    return started
  })

  on('command.run', { command: 'buddy' }, async ($, e) => {
    const [word, ...rest] = String(e.args ?? '').trim().split(/\s+/)
    const pet = (((await $.store.get('pet')) as PetInfo | undefined) ?? NEW_PET)
    if (word === 'reset') {
      await update($, caught, () => ({ send: 0, spend: 0, danger: 0 }))
      await $.store.set('caught', { send: 0, spend: 0, danger: 0 })
      return { text: 'Buddy reset his "saved you from" counter.' }
    }
    if (word === 'rec') {
      const turnOn = rest[0] === 'on' ? true : rest[0] === 'off' ? false : !(await read($, recOn))
      await $.store.set('rec', turnOn)
      await update($, recOn, () => turnOn)
      return { text: turnOn ? 'Recording mode ON: keys, emails, phone numbers, money and hidden names are covered on screen in every chat.' : 'Recording mode OFF.' }
    }
    if (word === 'hatch') {
      await $.store.set('pet', { ...pet, stage: 'egg' })
      await update($, tick, n => n + 1)
      await $.ui.open({ id: PANE, title: 'Buddy' })
      return { text: 'A new egg appeared. Click it to hatch.' }
    }
    if (word === 'pet' && (SPECIES as readonly string[]).includes(rest[0] ?? '')) {
      await $.store.set('pet', { ...pet, stage: 'pet', species: rest[0] })
      await update($, tick, n => n + 1)
      return { text: `${pet.name} is now a ${rest[0]}.` }
    }
    if (word === 'name' && rest.length > 0) {
      const name = rest.join(' ').slice(0, 20)
      await $.store.set('pet', { ...pet, name })
      await update($, tick, n => n + 1)
      return { text: `Your pet is now called ${name}.` }
    }
    await $.ui.open({ id: PANE, title: 'Buddy' })
    return { text: 'Buddy is back. Try /buddy pet cat, /buddy name Rex, or /buddy hatch.' }
  })

  // Leaving the board when the chat ends.
  on('session.end', async ($, e, next) => {
    try {
      await writeChat($, { status: 'closed' })
    } catch {
      // board only
    }
    return next(e)
  })

  // Any question to you (Claude's or Buddy's own) marks this chat "waiting on you" on the board.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    try {
      await writeChat($, { status: 'waiting' })
    } catch {
      // board only
    }
    const answered = await next(e)
    try {
      await writeChat($, { status: 'working' })
    } catch {
      // board only
    }
    return answered
  })

  // The pet posts here: an egg finished hatching, or someone petted it.
  on('ui.message', async ($, e, next) => {
    const data = (e.data ?? {}) as { hatched?: boolean; petted?: boolean }
    const pet = (((await $.store.get('pet')) as PetInfo | undefined) ?? NEW_PET)
    if (data.hatched && pet.stage === 'egg') {
      const species = SPECIES[Math.floor(Math.random() * SPECIES.length)]
      await $.store.set('pet', { ...pet, stage: 'pet', species })
      $.ui.toast(`Your egg hatched: ${pet.name} is a ${species}!`)
      await update($, tick, n => n + 1)
    } else if (data.petted) {
      await $.store.set('pet', { ...pet, pets: (pet.pets ?? 0) + 1 })
    }
    return next(e)
  })

  // Always-on strip above the prompt: works at any window width.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props?.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const m = await read($, mood)
    const mem = await read($, memory)
    const c = await read($, caught)
    const pet = (((await $.store.get('pet')) as PetInfo | undefined) ?? NEW_PET)
    const [face] = faceFor(m, mem)
    const rec = await read($, recOn)
    await read($, tick)
    const bandSettings = ((await $.store.get('settings')) ?? {}) as Record<string, unknown>
    const bandKeep = Math.max(0.1, Number(bandSettings.todoDays ?? 1) || 1) * 86400000
    const todoCount = (((await $.store.get('todos')) ?? []) as Todo[]).filter(t => !t.done && Date.now() - t.at < bandKeep).length
    return (
      <Box>
        {rec && <Text color="red" bold>● REC </Text>}
        {todoCount > 0 && <Text color="yellow" bold>☐ {todoCount} for you </Text>}
        <Text color="yellow">{face} </Text>
        <Text dimColor>
          {pet.name} the {pet.stage === 'egg' ? 'egg' : pet.species} · memory {mem}% · saved you {total(c)}x · /buddy
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    await read($, tick)
    const now = await $.clock.now()
    const view = await read($, tab)
    const m = await read($, mood)
    const mem = await read($, memory)
    const c = await read($, caught)
    const [face, caption] = faceFor(m, mem)
    const live = ((await $.store.get('jobs')) ?? {}) as Record<string, boolean>
    const isOn = (id: string) => (id === 'codex' ? o.codexEnabled === true : live[id] !== undefined ? live[id] : o[id] !== false)

    const switchTo = async (command: string, args: string) => {
      try {
        await $.command.run({ command, args })
      } catch {
        $.ui.toast(`Type /${command} ${args} to switch`)
      }
    }
    const toggle = async (id: string) => {
      const jobs = ((await $.store.get('jobs')) ?? {}) as Record<string, boolean>
      const turnedOn = !isOn(id)
      await $.store.set('jobs', { ...jobs, [id]: turnedOn })
      $.ui.toast(`Buddy: ${JOBS.find(j => j.id === id)?.name} ${turnedOn ? 'ON' : 'OFF'}`)
      await update($, tick, n => n + 1)
    }
    const compactNow = async () => {
      try {
        await $.session.compact({})
        $.ui.toast('Buddy compacted the chat')
      } catch {
        $.ui.toast('Type /compact to compact')
      }
    }
    const handoffNow = async () => {
      try {
        await $.command.run({ command: 'handoff', args: '' })
      } catch {
        $.ui.toast('Type /handoff')
      }
    }
    const resetCount = async () => {
      await update($, caught, () => ({ send: 0, spend: 0, danger: 0 }))
      await $.store.set('caught', { send: 0, spend: 0, danger: 0 })
      $.ui.toast('Buddy reset his caught counter')
    }

    // A titled card with a rounded border.
    const card = (title: string, children: any, color = 'gray') => (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginBottom={1}>
        <Text bold color={color === 'gray' ? undefined : color}>{title}</Text>
        {children}
      </Box>
    )

    const pet = (((await $.store.get('pet')) as PetInfo | undefined) ?? NEW_PET)
    const { Client } = $.ui.resolve(e) as any
    const rec = await read($, recOn)
    const panelNames = ((await $.store.get('settings')) ?? {}) as Record<string, any>
    const hide = nameList(panelNames.hideNames ?? o.hideNames)
    const shown = (s: string) => (rec ? maskText(s, hide) : s)
    const toggleRec = async () => {
      const turnOn = !rec
      await $.store.set('rec', turnOn)
      await update($, recOn, () => turnOn)
      $.ui.toast(turnOn ? 'Buddy: recording mode ON. Secrets, emails, money and hidden names are covered.' : 'Buddy: recording mode OFF')
    }
    // To-dos fade after a few days (Settings: To-dos last), so the list only holds what's blocking you now.
    const todoSettings = ((await $.store.get('settings')) ?? {}) as Record<string, unknown>
    const todoDays = Math.max(0.1, Number(todoSettings.todoDays ?? 1) || 1)
    const todos = (((await $.store.get('todos')) ?? []) as Todo[]).filter(t => !t.done && Date.now() - t.at < todoDays * 86400000)
    const doneAll = async () => {
      for (const todo of todos) await finishTodo(todo, true)
    }
    const clearTodos = async () => {
      const all = ((await $.store.get('todos')) ?? []) as Todo[]
      const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.') as string
      const file = `${home.replace(/\\/g, '/')}/.claude/buddy/todo-archive.json`
      let old: unknown[] = []
      try {
        old = JSON.parse(await $.fs.read(file))
      } catch {
        old = []
      }
      await $.fs.write(file, JSON.stringify([...old, ...all.map(t => ({ ...t, clearedAt: Date.now() }))], null, 1))
      await $.store.set('todos', [])
      $.ui.toast('Buddy cleared your to-dos (saved in ~/.claude/buddy/todo-archive.json)')
      await update($, tick, n => n + 1)
    }
    const finishTodo = async (todo: Todo, tell: boolean) => {
      const all = ((await $.store.get('todos')) ?? []) as Todo[]
      await $.store.set('todos', all.filter(t => t.id !== todo.id && !t.done).slice(-20))
      await update($, tick, n => n + 1)
      if (!tell) return
      const text = `Done: ${todo.task}. Carry on.`
      try {
        if (todo.sessionId === selfId) await $.prompt.submit({ text })
        else await $.session.send({ to: { sessionId: todo.sessionId }, text })
        $.ui.toast("Buddy told Claude it's done")
      } catch {
        $.ui.toast(`Buddy couldn't reach that chat. Tell it: ${text}`)
      }
    }
    const petMood = m !== 'holding' && mem >= 80 ? 'tired' : m

    const header = (
      <Box flexDirection="column" marginBottom={1}>
        <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Client
            key="pet"
            module="./pet.tsx"
            height={7}
            props={{ species: pet.species, mood: petMood, stage: pet.stage, name: pet.name, label: pet.stage === 'egg' ? '' : caption }}
          />
        </Box>
        <Box gap={2}>
          <Button key="rec-switch" variant={rec ? 'primary' : 'secondary'} label={rec ? '● REC ON' : 'Recording mode'} onPress={toggleRec} />
          <Text dimColor>{rec ? 'Keys, emails, money and hidden names are covered on screen.' : 'Filming or sharing your screen? Press this first.'}</Text>
        </Box>
        <Box gap={2} marginTop={1} flexWrap="wrap">
          <Button key="tab-status" variant={view === 'status' ? 'primary' : 'secondary'} label="Status" onPress={() => update($, tab, () => 'status')} />
          <Button key="tab-chats" variant={view === 'chats' ? 'primary' : 'secondary'} label="Chats" onPress={() => update($, tab, () => 'chats')} />
          <Button key="tab-threads" variant={view === 'threads' ? 'primary' : 'secondary'} label="Threads" onPress={() => update($, tab, () => 'threads')} />
          <Button
            key="tab-codex"
            variant={view === 'codex' ? 'primary' : 'secondary'}
            label="Codex"
            onPress={async () => {
              await update($, tab, () => 'codex')
              await scanCodexForPanel($)
            }}
          />
          <Button
            key="tab-skills"
            variant={view === 'skills' ? 'primary' : 'secondary'}
            label="Skills"
            onPress={async () => {
              await update($, tab, () => 'skills')
              await scanAllSkills($)
            }}
          />
          <Button key="tab-jobs" variant={view === 'jobs' ? 'primary' : 'secondary'} label="Jobs" onPress={() => update($, tab, () => 'jobs')} />
          <Button key="tab-pets" variant={view === 'pets' ? 'primary' : 'secondary'} label="Pets" onPress={() => update($, tab, () => 'pets')} />
          <Button key="tab-settings" variant={view === 'settings' ? 'primary' : 'secondary'} label="Settings" onPress={() => update($, tab, () => 'settings')} />
          <Button key="tab-help" variant={view === 'help' ? 'primary' : 'secondary'} label="Help" onPress={() => update($, tab, () => 'help')} />
        </Box>
      </Box>
    )


    const chats = await readChats($)
    const ICON: Record<string, [string, string, string]> = {
      waiting: ['⏳', 'yellow', 'waiting on you'],
      working: ['●', 'cyan', 'working'],
      done: ['✓', 'green', 'your turn'],
      idle: ['○', 'gray', 'idle'],
    }
    const todoBy = (id: string) => todos.filter(t => t.sessionId === id).length
    const { Input: BoardInput } = $.ui.resolve(e) as any
    const messageChat = async (id: string, text: string) => {
      if (!text.trim()) return
      try {
        const sent = await $.session.send({ to: { sessionId: id }, text: `[from another chat, via Buddy] ${text.trim()}` })
        $.ui.toast(sent.isDelivered ? 'Buddy delivered your message' : `Not delivered: ${sent.reason}`)
      } catch {
        $.ui.toast("Buddy couldn't reach that chat")
      }
    }
    const chatRow = (row: ChatRow) => {
      const [icon, color, word] = ICON[row.status] ?? ['○', 'gray', row.status]
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={color}>{icon} {word}</Text>
            <Text dimColor> {ago(Date.now() - row.since)}</Text>
            <Text bold> {shown(row.title || 'new chat')}</Text>
            {row.id === selfId ? <Text dimColor> (this chat)</Text> : null}
          </Text>
          <Text dimColor>   {shown(row.folder)}{todoBy(row.id) > 0 ? ` · ☐ ${todoBy(row.id)} for you` : ''}</Text>
          {view === 'chats' && row.id !== selfId && (
            <BoardInput key={`msg-${row.id}`} placeholder="Message this chat..." submitLabel="send" onSubmit={(v: string) => messageChat(row.id, v)} />
          )}
        </Box>
      )
    }
    const waitingCount = chats.filter(r => r.status === 'waiting').length
    const boardCard = card(
      waitingCount > 0 ? `Your chats · ${waitingCount} waiting on you` : `Your chats · ${chats.length} open`,
      <Box flexDirection="column" gap={1}>
        {chats.length === 0 && <Text dimColor>Open Claude Code chats show up here.</Text>}
        {chats.slice(0, view === 'chats' ? 20 : 3).map(chatRow)}
        {view !== 'chats' && chats.length > 3 && <Text dimColor>+{chats.length - 3} more in the Chats tab</Text>}
      </Box>,
      waitingCount > 0 ? 'yellow' : 'cyan',
    )

    const todoCard =
      todos.length > 0 &&
      card(
        `For you to do · ${todos.length}`,
        <Box flexDirection="column" gap={1}>
          {todos.slice(0, 5).map(todo => (
            <Box flexDirection="column">
              <Box gap={2}>
                <Button key={`todo-done-${todo.id}`} variant="primary" label="Done" onPress={() => finishTodo(todo, true)} />
                <Button key={`todo-skip-${todo.id}`} label="Skip" onPress={() => finishTodo(todo, false)} />
                <Text bold>{shown(todo.task)}</Text>
              </Box>
              <Text dimColor>
                {'   '}
                {todo.chat ? `from "${shown(todo.chat)}"` : 'from a chat'}
                {todo.sessionId === selfId ? ' (this chat)' : ''}
                {todo.doneWhen ? ` · done when ${shown(todo.doneWhen)}` : ''}
              </Text>
            </Box>
          ))}
          {todos.length > 5 && <Text dimColor>+{todos.length - 5} more</Text>}
          <Box gap={2}>
            <Button key="todo-done-all" label="Done all" onPress={doneAll} />
            <Button key="todo-clear" label="Skip all" onPress={clearTodos} />
          </Box>
          <Box>
            <Text dimColor>
              Done tells that chat to carry on. Skip clears it. To-dos fade after {todoDays} day{todoDays === 1 ? '' : 's'} (change it in Settings).
            </Text>
          </Box>
        </Box>,
        'yellow',
      )

    if (view === 'codex') {
      const { Input: CInput } = $.ui.resolve(e) as any
      const panel = ((await $.store.get('settings')) ?? {}) as Record<string, any>
      const cxOn = (panel.codexEnabled ?? o.codexEnabled) === true
      const cxModel = String(panel.codexModel ?? o.codexModel ?? 'gpt-5.5')
      const jobs = await read($, codexJobs)
      const threads = await read($, cxThreads)
      const canEdit = await read($, cxEdit)
      const peeked = await read($, peek)
      const cx = async (args: string) => {
        try {
          await $.command.run({ command: 'buddy-codex', args })
        } catch {
          $.ui.toast(`Type /buddy-codex ${args}`)
        }
      }
      const turnOn = async () => {
        const cur = ((await $.store.get('settings')) ?? {}) as Record<string, unknown>
        await $.store.set('settings', { ...cur, codexEnabled: true })
        $.ui.toast('Buddy: Codex team ON')
        await update($, tick, n => n + 1)
      }
      const jobIcon = (s: string) => (s === 'running' ? ['● working', 'cyan'] : s === 'failed' ? ['✗ failed', 'red'] : ['✓ done', 'green'])
      if (!cxOn) {
        return (
          <Box flexDirection="column">
            {header}
            {card(
              'Codex team is off',
              <Box flexDirection="column" gap={1}>
                <Text>Turn it on to let Claude start and message OpenAI Codex agents, and to see your Codex threads here.</Text>
                <Text dimColor>Needs the Codex CLI installed and logged in. Whatever you or Claude send to Codex goes to OpenAI.</Text>
                <Box>
                  <Button key="cx-on" variant="primary" label="Turn on Codex team" onPress={turnOn} />
                </Box>
              </Box>,
              'magenta',
            )}
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>Claude is the lead; Codex agents work for it. Start one, message any Codex thread, watch them work.</Text>
          <Text> </Text>
          {card(
            'Start a Codex agent',
            <Box flexDirection="column" gap={1}>
              <Box gap={2} flexWrap="wrap">
                <Button key="cx-read" variant={!canEdit ? 'primary' : 'secondary'} label="Read-only" onPress={() => update($, cxEdit, () => false)} />
                <Button key="cx-edit" variant={canEdit ? 'primary' : 'secondary'} label="Can edit files" onPress={() => update($, cxEdit, () => true)} />
                <Text dimColor>Model: {cxModel} (change it in Settings)</Text>
              </Box>
              <CInput
                key="cx-task"
                placeholder="What should Codex do? e.g. review notes.md and list every weak sentence"
                submitLabel="start"
                onSubmit={(v: string) => v.trim() && cx(`start ${cxModel} ${canEdit ? 'edit' : 'read'} ${v.trim()}`)}
              />
              <Text dimColor>{canEdit ? 'Can edit files: you are asked to confirm before it starts.' : 'Read-only: Codex can look but not change anything.'}</Text>
            </Box>,
            'magenta',
          )}
          {card(
            jobs.some(j => j.status === 'running') ? `Codex agents · ${jobs.filter(j => j.status === 'running').length} working` : 'Codex agents',
            <Box flexDirection="column" gap={1}>
              {jobs.length === 0 && <Text dimColor>None yet. Start one above, or ask Claude to "have Codex review this".</Text>}
              {jobs.map(job => {
                const [icon, color] = jobIcon(job.status)
                const busy = job.status === 'running'
                return (
                  <Box flexDirection="column">
                    <Text>
                      <Text color={color}>{icon}</Text>
                      <Text bold> {shown(job.task.slice(0, 60))}</Text>
                      <Text dimColor>
                        {' '}· started by {job.by} · {job.model} · {job.canEdit ? 'can edit' : 'read-only'} · {ago((job.endedAt ?? Date.now()) - job.startedAt)}
                        {job.tokens ? ` · ${Math.round(job.tokens / 1000)}K tokens` : ''}
                        {busy && job.lastAction ? ` · now: ${shown(job.lastAction)}` : ''}
                      </Text>
                    </Text>
                    {!busy && (
                      <Box gap={2} marginLeft={3}>
                        {job.answer && (
                          <Button key={`cx-ans-${job.id}`} label={peeked?.id === job.id ? 'Hide answer' : 'Answer'} onPress={() => update($, peek, () => (peeked?.id === job.id ? null : { id: job.id, text: job.answer ?? '' }))} />
                        )}
                      </Box>
                    )}
                    {!busy && (
                      <Box marginLeft={3}>
                        <CInput key={`cx-msg-${job.id}`} placeholder="Next message to this Codex agent..." submitLabel="send" onSubmit={(v: string) => v.trim() && cx(`msg ${job.id} ${v.trim()}`)} />
                      </Box>
                    )}
                    {peeked && peeked.id === job.id && <Text dimColor>{shown(peeked.text.slice(0, 1500))}</Text>}
                  </Box>
                )
              })}
            </Box>,
            'cyan',
          )}
          {card(
            'Your Codex threads',
            <Box flexDirection="column" gap={1}>
              {threads === null && <Text dimColor>Reading your Codex threads...</Text>}
              {threads !== null && threads.length === 0 && <Text dimColor>No Codex threads in the last two weeks.</Text>}
              {(threads ?? []).slice(0, 10).map(th => {
                const working = th.status === 'working' || jobs.some(j => j.threadId === th.id && j.status === 'running')
                return (
                  <Box flexDirection="column">
                    <Text>
                      <Text color={working ? 'cyan' : 'gray'}>{working ? '● working' : '○ idle'}</Text>
                      <Text bold> {shown(th.name.slice(0, 48))}</Text>
                      <Text dimColor> · {th.from} · {shown(th.folder)} · {ago(Date.now() - th.updatedAt)} ago</Text>
                    </Text>
                    {th.lastReply && (
                      <Box gap={2} marginLeft={3}>
                        <Button key={`cx-peek-${th.id}`} label={peeked?.id === th.id ? 'Hide' : 'Peek'} onPress={() => update($, peek, () => (peeked?.id === th.id ? null : { id: th.id, text: th.lastReply }))} />
                      </Box>
                    )}
                    {peeked && peeked.id === th.id && <Text dimColor>{shown(peeked.text)}</Text>}
                    {!working && (
                      <Box marginLeft={3}>
                        <CInput key={`cx-tmsg-${th.id}`} placeholder="Message this Codex thread..." submitLabel="send" onSubmit={(v: string) => v.trim() && cx(`msg ${th.id} ${v.trim()}`)} />
                      </Box>
                    )}
                  </Box>
                )
              })}
              <Box gap={2}>
                <Button key="cx-refresh" label="Refresh" onPress={() => scanCodexForPanel($)} />
                <Text dimColor>Messages only go to idle threads. A thread open in the Codex app shows new messages after you reopen it.</Text>
              </Box>
            </Box>,
          )}
        </Box>
      )
    }

    if (view === 'skills') {
      const { Input: SInput } = $.ui.resolve(e) as any
      const scan = await read($, skillScan)
      const sv = await read($, skillView)
      const use = ((await $.store.get('skillUse')) ?? {}) as SkillUse
      const since = (await $.store.get('skillUseSince')) as number | undefined
      const items = scan?.items ?? []
      const usesOf = (it: SkillItem) => use[it.name]?.count ?? 0
      const q = sv.q.trim().toLowerCase()
      const filtered = items
        .filter(it => !q || it.name.toLowerCase().includes(q) || it.description.toLowerCase().includes(q))
        .sort((a, b) =>
          sv.sort === 'used'
            ? usesOf(b) - usesOf(a) || a.name.localeCompare(b.name)
            : sv.sort === 'unused'
              ? usesOf(a) - usesOf(b) || b.descChars - a.descChars
              : b.descChars - a.descChars,
        )
      const tokens = Math.round(items.reduce((sum, it) => sum + it.descChars, 0) / 4)
      const neverUsed = items.filter(it => usesOf(it) === 0).length
      const dupes = new Set(items.filter((it, i) => items.findIndex(x => x.name === it.name) !== i).map(it => it.name))
      const setView = (patch: Partial<typeof sv>) => update($, skillView, v => ({ ...v, ...patch }))
      const act = async (args: string) => {
        try {
          await $.command.run({ command: 'buddy-skills', args })
        } catch {
          $.ui.toast(`Type /buddy-skills ${args}`)
        }
        await scanAllSkills($)
      }
      const folderOf = (it: SkillItem) => it.path.slice(it.path.lastIndexOf('/') + 1)
      const sortBtn = (id: 'used' | 'unused' | 'big', label: string) => (
        <Button key={`ssort-${id}`} variant={sv.sort === id ? 'primary' : 'secondary'} label={label} onPress={() => setView({ sort: id, shown: 15 })} />
      )
      const lastUsed = (it: SkillItem) => (use[it.name] ? `used ${use[it.name].count}x · last ${ago(Date.now() - use[it.name].last)} ago` : 'never used')
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>Every skill you have, how often Claude really uses it, and what it costs. Copy, move or delete with one click.</Text>
          <Text> </Text>
          {card(
            'Your skills',
            <Box flexDirection="column" gap={1}>
              {!scan && <Text dimColor>Scanning...</Text>}
              {scan && (
                <Box flexDirection="column">
                  {rec ? (
                    <Text dimColor>Skill counts and names are hidden while recording.</Text>
                  ) : (
                    <Text>
                      <Text bold>{items.filter(i => i.scope === 'project').length}</Text> in this project · <Text bold>{items.filter(i => i.scope === 'global').length}</Text> global ·{' '}
                      <Text bold color={neverUsed > 0 ? 'yellow' : 'green'}>{neverUsed}</Text> never used
                    </Text>
                  )}
                  <Text color="yellow">About {tokens.toLocaleString()} tokens of skill names and descriptions ride along in every chat (estimate)</Text>
                  <Text dimColor>{since ? `Counting use since ${new Date(since).toLocaleDateString()}. ` : 'Counting starts now: each skill Claude loads is counted. '}Counts cover every chat and project.</Text>
                  {dupes.size > 0 && <Text color="yellow">Same name in two places: {rec ? `${dupes.size} skills` : [...dupes].slice(0, 6).join(', ')}</Text>}
                  {rec && <Text color="red">● Recording: skill names and descriptions are hidden.</Text>}
                  {scan.codexLink && <Text dimColor>This project shares its skills with Codex (.agents/skills). Moving a skill out of the project removes it for Codex too.</Text>}
                </Box>
              )}
              <Box gap={2} flexWrap="wrap">
                {sortBtn('used', 'Most used')}
                {sortBtn('unused', 'Never used')}
                {sortBtn('big', 'Biggest')}
                <Button key="sscan" label="Rescan" onPress={() => scanAllSkills($)} />
              </Box>
              <SInput key="squery" placeholder="Search skills..." submitLabel="search" onSubmit={(v: string) => setView({ q: v, shown: 15 })} />
              {sv.q && <Text dimColor>Showing matches for "{sv.q}" · <Text color="cyan">clear by searching for nothing</Text></Text>}
            </Box>,
            'magenta',
          )}
          {filtered.slice(0, sv.shown).map(it => {
            const key = `${it.scope}:${folderOf(it)}`
            const opened = sv.open === key
            return (
              <Box flexDirection="column" marginBottom={1}>
                <Box gap={2}>
                  <Button key={`sopen-${key}`} label={opened ? 'Close' : 'Manage'} onPress={() => setView({ open: opened ? '' : key })} />
                  <Text>
                    <Text bold>{rec ? '█'.repeat(Math.min(12, Math.max(4, it.name.length))) : it.name}</Text>
                    <Text color={it.scope === 'project' ? 'cyan' : 'magenta'}> {it.scope === 'project' ? 'this project' : 'global'}</Text>
                    {it.isLink && <Text dimColor> · linked</Text>}
                    <Text color={usesOf(it) > 0 ? 'green' : 'yellow'}> · {lastUsed(it)}</Text>
                    <Text dimColor> · ~{Math.round(it.descChars / 4)} tokens</Text>
                  </Text>
                </Box>
                {opened && (
                  <Box flexDirection="column" marginLeft={4} gap={1}>
                    <Text dimColor>{rec ? 'Hidden while recording.' : it.description || '(no description)'}</Text>
                    {it.isLink ? (
                      <Text dimColor>This one is a linked folder, managed somewhere else. Buddy won't copy, move or delete it.</Text>
                    ) : (
                      <Box flexDirection="column" gap={1}>
                        <Box gap={2} flexWrap="wrap">
                          {it.scope === 'project' && <Button key={`sg-${key}`} label="Make global (copy)" onPress={() => act(`global ${folderOf(it)}`)} />}
                          {it.scope === 'project' && <Button key={`sm-${key}`} label="Move to global" onPress={() => act(`moveglobal ${folderOf(it)}`)} />}
                          {it.scope === 'global' && <Button key={`sh-${key}`} label="Add to this project" onPress={() => act(`here ${folderOf(it)}`)} />}
                          <Button key={`sd-${key}`} label="Delete" onPress={() => act(`delete ${key}`)} />
                        </Box>
                        <SInput
                          key={`sc-${key}`}
                          placeholder="Copy to another project: paste its folder path"
                          submitLabel="copy"
                          onSubmit={(v: string) => v.trim() && act(`copy ${key} ${v.trim()}`)}
                        />
                        <Text dimColor>Copies keep the original. Move and Delete ask first and keep a backup in ~/.claude/buddy/skill-backups.</Text>
                      </Box>
                    )}
                  </Box>
                )}
              </Box>
            )
          })}
          {filtered.length > sv.shown && <Button key="smore" label={rec ? 'Show more' : `Show more (${filtered.length - sv.shown} left)`} onPress={() => setView({ shown: sv.shown + 25 })} />}
        </Box>
      )
    }

    if (view === 'threads') {
      const { Input: TInput } = $.ui.resolve(e) as any
      const model = await read($, threadModel)
      const kind = await read($, threadKind)
      const live = await read($, agentLive)
      const threads = await read($, chatThreads)
      const peeked = await read($, peek)
      const metaAll = ((await $.store.get('agentMeta')) ?? {}) as Record<string, { by: string; model: string }>
      let helpers: { id: string; description: string; type: string; status: string; parentId?: string; spawnedBy?: string }[] = []
      try {
        helpers = (await $.agent.list()) as any
      } catch {
        helpers = []
      }
      const rowsById = Object.fromEntries((await read($, agents)).map(r => [r.id, r]))
      const startThread = async (task: string) => {
        const text = task.trim()
        if (!text) return
        if (kind === 'chat') {
          try {
            await $.command.run({ command: 'thread', args: text })
          } catch {
            $.ui.toast('Type /thread followed by the task')
          }
          return
        }
        try {
          const started = await $.agent.spawn({ prompt: text, description: text.slice(0, 40), model })
          if (started.agentId) {
            const meta = ((await $.store.get('agentMeta')) ?? {}) as Record<string, unknown>
            await $.store.set('agentMeta', { ...meta, [started.agentId]: { by: 'you', model } })
            $.ui.toast(`Buddy started a ${model} helper`)
          } else $.ui.toast(`Not started: ${started.deny ?? 'refused'}`)
        } catch (err) {
          $.ui.toast(`Couldn't start it: ${String((err as Error)?.message ?? err).slice(0, 80)}`)
        }
        await update($, tick, n => n + 1)
      }
      const peekAgent = async (id: string) => {
        try {
          const rows = (await $.session.messages({ agentId: id })) as any
          const list = Array.isArray(rows) ? rows : []
          const text = list
            .slice(-4)
            .map((r: any) => `${r.role === 'assistant' ? 'Helper' : 'Task'}: ${String(r.text ?? '').replace(/\s+/g, ' ').slice(0, 220)}`)
            .join('\n')
          await update($, peek, () => ({ id, text: text || 'Nothing to show yet.' }))
        } catch {
          await update($, peek, () => ({ id, text: "Couldn't read that helper's messages." }))
        }
      }
      const messageAgent = async (id: string, text: string) => {
        if (!text.trim()) return
        try {
          const sent = await $.session.send({ to: { agentId: id }, text: text.trim() })
          $.ui.toast(sent.isDelivered ? 'Buddy passed your message on' : `Not delivered: ${sent.reason}`)
        } catch {
          $.ui.toast("Buddy couldn't reach that helper")
        }
      }
      const stopAgent = async (id: string) => {
        try {
          await $.tool.call({ tool: 'TaskStop', task_id: id } as any)
          $.ui.toast('Buddy stopped that helper')
        } catch {
          $.ui.toast("Buddy couldn't stop it. Press Esc in the chat to stop everything")
        }
        await update($, tick, n => n + 1)
      }
      const messageThread = async (id: string, text: string) => {
        if (!text.trim()) return
        try {
          await $.command.run({ command: 'thread', args: `msg ${id} ${text.trim()}` })
        } catch {
          $.ui.toast(`Type /thread msg ${id} followed by your message`)
        }
      }
      const isRunning = (s: string) => /run|progress|start|pending|active/i.test(s)
      const runningCount = helpers.filter(ag => isRunning(ag.status)).length + threads.filter(t => t.status === 'running' || t.status === 'starting').length
      const pick = (m: string, label: string) => (
        <Button key={`model-${m}`} variant={model === m ? 'primary' : 'secondary'} label={label} onPress={() => update($, threadModel, () => m)} />
      )
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>One chat, a whole team. Start helpers or separate chats, watch what each is doing, and steer or stop them.</Text>
          <Text> </Text>
          {card(
            'Start a thread',
            <Box flexDirection="column" gap={1}>
              <Box gap={2} flexWrap="wrap">
                <Button key="kind-helper" variant={kind === 'helper' ? 'primary' : 'secondary'} label="Helper in this chat" onPress={() => update($, threadKind, () => 'helper')} />
                <Button key="kind-chat" variant={kind === 'chat' ? 'primary' : 'secondary'} label="Separate chat" onPress={() => update($, threadKind, () => 'chat')} />
              </Box>
              <Box gap={2} flexWrap="wrap">
                {pick('sonnet', 'Sonnet')}
                {pick('opus', 'Opus')}
                {pick('fable', 'Fable')}
              </Box>
              <TInput key="thread-task" placeholder="What should it do? e.g. research the top 5 competitors and summarize" submitLabel="start" onSubmit={startThread} />
              <Text dimColor>
                {kind === 'helper'
                  ? 'A helper works inside this chat and reports back to it.'
                  : 'A separate chat is its own Claude session in the background, with its own memory. Its answer lands in the card below.'}
              </Text>
            </Box>,
            'magenta',
          )}
          {card(
            runningCount > 0 ? `Your team · ${runningCount} working` : 'Your team',
            <Box flexDirection="column" gap={1}>
              <Text bold>● This chat (the lead)</Text>
              {helpers.length === 0 && threads.length === 0 && <Text dimColor>   No helpers yet. Start one above, or ask Claude to split a job across helpers.</Text>}
              {helpers.map(ag => {
                const lv = live[ag.id]
                const row = rowsById[ag.id]
                const by = metaAll[ag.id]?.by ?? (ag.spawnedBy ? 'Buddy' : 'Claude')
                const busy = isRunning(ag.status)
                return (
                  <Box flexDirection="column">
                    <Text>
                      <Text>{ag.parentId ? '      └ ' : '   └ '}</Text>
                      <Text color={busy ? 'cyan' : 'green'}>{busy ? '● working' : `✓ ${ag.status}`}</Text>
                      <Text bold> {shown(ag.description || ag.type)}</Text>
                      <Text dimColor>
                        {' '}· helper · started by {by}
                        {metaAll[ag.id]?.model ? ` · ${metaAll[ag.id]?.model}` : ''}
                        {row ? ` · ${elapsed(row, now)}` : ''}
                        {lv ? ` · ${lv.steps} steps` : ''}
                        {busy && lv?.tool ? ` · now: ${lv.tool}` : ''}
                      </Text>
                    </Text>
                    <Box gap={2} marginLeft={6}>
                      <Button key={`peek-${ag.id}`} label="Peek" onPress={() => peekAgent(ag.id)} />
                      {busy && <Button key={`stop-${ag.id}`} label="Stop" onPress={() => stopAgent(ag.id)} />}
                    </Box>
                    {busy && (
                      <Box marginLeft={6}>
                        <TInput key={`steer-${ag.id}`} placeholder="Message this helper..." submitLabel="send" onSubmit={(v: string) => messageAgent(ag.id, v)} />
                      </Box>
                    )}
                    {peeked && peeked.id === ag.id && <Text dimColor>{shown(peeked.text)}</Text>}
                  </Box>
                )
              })}
              {threads.map(th => {
                const busy = th.status === 'running' || th.status === 'starting'
                return (
                  <Box flexDirection="column">
                    <Text>
                      <Text>   └ </Text>
                      <Text color={busy ? 'cyan' : th.status === 'failed' ? 'red' : 'green'}>{busy ? '● working' : th.status === 'failed' ? '✗ failed' : '✓ done'}</Text>
                      <Text bold> {shown(th.task.slice(0, 60))}</Text>
                      <Text dimColor>
                        {' '}· separate chat {th.id} · started by {th.by} · {th.model} · {ago((th.endedAt ?? Date.now()) - th.startedAt)}
                        {th.turns > 1 ? ` · ${th.turns} messages` : ''}
                        {busy && th.lastTool ? ` · now: ${th.lastTool}` : ''}
                      </Text>
                    </Text>
                    <Box gap={2} marginLeft={6}>
                      {!busy && th.answer && (
                        <Button
                          key={`answer-${th.id}`}
                          label={peeked?.id === th.id ? 'Hide answer' : 'Answer'}
                          onPress={() => update($, peek, () => (peeked?.id === th.id ? null : { id: th.id, text: th.answer ?? '' }))}
                        />
                      )}
                    </Box>
                    {!busy && (
                      <Box marginLeft={6}>
                        <TInput key={`tmsg-${th.id}`} placeholder="Next message to this chat..." submitLabel="send" onSubmit={(v: string) => messageThread(th.id, v)} />
                      </Box>
                    )}
                    {peeked && peeked.id === th.id && <Text dimColor>{shown(peeked.text.slice(0, 1500))}</Text>}
                  </Box>
                )
              })}
            </Box>,
            'cyan',
          )}
          <Text dimColor>Your other open chats, with a message box on each, are in the Chats tab. Ask Claude to "split this across three helpers" or "start separate chats for each" and they show up here.</Text>
        </Box>
      )
    }

    if (view === 'chats') {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>Every Claude Code chat you have open, live. I ping you when one finishes or needs you. Type in a chat's box to send it a message from here.</Text>
          <Text> </Text>
          {todoCard}
          {boardCard}
          <Text dimColor>Waiting on you = it asked you something. Your turn = it finished and is waiting for your next message.</Text>
        </Box>
      )
    }

    if (view === 'pets') {
      const choose = async (species: string) => {
        await $.store.set('pet', { ...pet, stage: 'pet', species })
        $.ui.toast(`${pet.name} is now a ${species}`)
        await update($, tick, n => n + 1)
      }
      const newEgg = async () => {
        await $.store.set('pet', { ...pet, stage: 'egg' })
        await update($, tick, n => n + 1)
      }
      return (
        <Box flexDirection="column">
          {header}
          {card(
            'Pick your pet',
            <Box flexDirection="column" gap={1}>
              <Box gap={2} flexWrap="wrap">
                {SPECIES.slice(0, 4).map(sp => (
                  <Button key={`sp-${sp}`} variant={pet.species === sp && pet.stage === 'pet' ? 'primary' : 'secondary'} label={sp} onPress={() => choose(sp)} />
                ))}
              </Box>
              <Box gap={2} flexWrap="wrap">
                {SPECIES.slice(4).map(sp => (
                  <Button key={`sp-${sp}`} variant={pet.species === sp && pet.stage === 'pet' ? 'primary' : 'secondary'} label={sp} onPress={() => choose(sp)} />
                ))}
              </Box>
              <Text dimColor>Click your pet above to pet it. Petted {pet.pets ?? 0} times.</Text>
            </Box>,
            'yellow',
          )}
          {card(
            'Hatch a surprise',
            <Box flexDirection="column" gap={1}>
              <Box gap={2}>
                <Button key="new-egg" label="Get a new egg" onPress={newEgg} />
                <Text dimColor>Click the egg to hatch a random pet</Text>
              </Box>
              <Text dimColor>Rename: /buddy name Rex · Pick by command: /buddy pet dragon</Text>
            </Box>,
          )}
          {card(
            'How your pet acts',
            <Box flexDirection="column">
              <Text dimColor>Napping (z z) while waiting on you</Text>
              <Text dimColor>Walking around while Claude works</Text>
              <Text dimColor>Dancing (♪) when a task finishes</Text>
              <Text dimColor>Shaking (!) when holding something for you</Text>
              <Text dimColor>Worn out when the chat's memory is nearly full</Text>
            </Box>,
          )}
        </Box>
      )
    }

    if (view === 'jobs') {
      const held = await read($, lastHeld)
      const log = ((await $.store.get('log')) ?? []) as { at: number; kind: string; what: string; choice: string }[]
      const appr = ((await $.store.get('approvals')) ?? { date: '', targets: [] }) as { date: string; targets: string[] }
      const todayKey = new Date().toISOString().slice(0, 10)
      const approvedNow = appr.date === todayKey ? appr.targets : []
      const undoApproval = async (target: string) => {
        await $.store.set('approvals', { date: todayKey, targets: approvedNow.filter(x => x !== target) })
        $.ui.toast('Buddy will ask about that again')
        await update($, tick, n => n + 1)
      }
      const clock = (at: number) => {
        const d = new Date(at)
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      }
      const KIND_LABEL: Record<string, string> = { send: 'send', spend: 'paid call', danger: 'delete', locked: 'locked file', cache: 'cache' }
      const activityCard = card(
        'Activity',
        <Box flexDirection="column">
          <Text>
            Held <Text bold color="red">{c.send}</Text> sends · <Text bold color="red">{c.spend}</Text> paid calls · stopped <Text bold color="red">{c.danger}</Text> deletes
          </Text>
          {log.length === 0 && <Text dimColor>Nothing yet. Every time I step in, it shows up here with what you chose.</Text>}
          {log.slice(0, 8).map(entry => (
            <Text>
              <Text dimColor>{clock(entry.at)} </Text>
              <Text bold>{KIND_LABEL[entry.kind] ?? entry.kind}</Text>
              <Text dimColor> {shown(entry.what.slice(0, 60))}{entry.what.length > 60 ? '…' : ''} → </Text>
              <Text color={/cancel|block/i.test(entry.choice) ? 'red' : 'green'}>{entry.choice}</Text>
            </Text>
          ))}
          {approvedNow.length > 0 && <Text bold>Approved for today (won't ask again until tomorrow):</Text>}
          {approvedNow.map(target => (
            <Box gap={2}>
              <Button key={`undo-${target}`} label="Undo" onPress={() => undoApproval(target)} />
              <Text>{target.replace(/^(mcp|host|cli|shell|git|gh|vercel|fly|npm):/, '')}</Text>
            </Box>
          ))}
          {held ? <Text dimColor>Last one: {shown(held)}</Text> : null}
          <Box marginTop={1}>
            <Button key="reset" label="Reset counter" onPress={resetCount} />
          </Box>
        </Box>,
        'red',
      )
      const group = (name: string, color: string) =>
        card(
          name,
          <Box flexDirection="column" gap={1}>
            {JOBS.filter(j => j.group === name).map(job => (
              <Box flexDirection="column">
                <Box gap={2}>
                  <Button
                    key={`job-${job.id}`}
                    variant={isOn(job.id) ? 'primary' : 'secondary'}
                    label={isOn(job.id) ? 'ON' : 'OFF'}
                    onPress={() => (job.live ? toggle(job.id) : $.ui.toast('Change this one in Buddy settings (/config)'))}
                  />
                  <Text bold color={isOn(job.id) ? 'green' : 'gray'}>{job.name}</Text>
                  <Text dimColor>
                    {job.id === 'sendGate' ? `held ${c.send}x` : job.id === 'spendGate' ? `held ${c.spend}x` : job.id === 'dangerGuard' ? `stopped ${c.danger}x` : ''}
                  </Text>
                </Box>
                <Text dimColor>{job.what}</Text>
              </Box>
            ))}
          </Box>,
          color,
        )
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>Press ON/OFF to switch a job. It takes effect right away. What I stepped in on is at the bottom.</Text>
          <Text> </Text>
          {group('Guards', 'red')}
          {group('Watches', 'cyan')}
          {group('Helps', 'magenta')}
          {activityCard}
          <Text dimColor>Your email, locked files, house rules, banned words, extra paid APIs and Codex are in Buddy's settings (/config).</Text>
        </Box>
      )
    }

    const { Input } = $.ui.resolve(e) as any
    const panelSettings = ((await $.store.get('settings')) ?? {}) as Record<string, any>
    const setting = (k: string) => (panelSettings[k] !== undefined ? panelSettings[k] : o[k])
    const saveSetting = async (k: string, v: unknown, label: string) => {
      const cur = ((await $.store.get('settings')) ?? {}) as Record<string, unknown>
      await $.store.set('settings', { ...cur, [k]: v })
      $.ui.toast(`Buddy saved: ${label}`)
      await update($, tick, n => n + 1)
    }

    if (view === 'settings') {
      const field = (k: string, label: string, hint: string, placeholder: string) => (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{label}</Text>
          <Text dimColor>{hint}</Text>
          <Text color="yellow">Now: {String(setting(k) ?? '') || '(empty)'}</Text>
          <Input key={`set-${k}`} placeholder={placeholder} submitLabel="save" onSubmit={(v: string) => saveSetting(k, v.trim(), label)} />
        </Box>
      )
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>Type a new value and press Enter to save. Changes apply right away.</Text>
          <Text> </Text>
          {card(
            'Guards',
            <Box flexDirection="column">
              {field('myEmail', 'My email', "Where 'Send to me first' sends test copies. Empty hides that button.", 'you@example.com')}
              {field('lockedFiles', 'Locked files', 'Comma-separated names or folders Claude may not edit.', '.env, contracts/, finances.xlsx')}
              {field('hideNames', 'Hide on screen', 'Names recording mode covers, like clients or your company. Comma-separated.', 'Acme Corp, Jane Smith')}
              {field('paidApis', 'Extra paid APIs', 'Comma-separated hosts the spend gate should also hold.', 'api.stripe.com, api.twilio.com')}
            </Box>,
            'red',
          )}
          {card(
            'Helps',
            <Box flexDirection="column">
              {field('houseRules', 'House rules', 'Rules Claude gets at the start of each new chat. Separate with ;', 'Never use em dashes; Always cite sources')}
              {field('bannedPhrases', 'Banned words', 'Buddy flags a reply that uses any of these. Comma-separated.', 'delve, synergy')}
              {field('codexModel', 'Codex model', 'Which model Codex agents use. Needs the Codex CLI logged in.', 'gpt-5.5')}
              {field('cacheMinutes', 'Cache lifetime (minutes)', 'How long the cache stays warm after a reply. Claude Code uses a 1-hour cache, so 60. Use 5 only if you run on the 5-minute cache.', '60')}
              {field('cacheAskAbove', 'Cache check above ($)', 'Buddy only asks when a cold-cache message would cost more than this.', '0.5')}
              {field('todoDays', 'To-dos last (days)', 'To-dos older than this drop off the list. Default 1.', '1')}
              {field('donePingSeconds', 'Done ping after (seconds)', 'Pop-up when a task takes longer than this.', '60')}
              <Box gap={2} marginTop={1}>
                <Button
                  key="codex-switch"
                  variant={setting('codexEnabled') === true ? 'primary' : 'secondary'}
                  label={setting('codexEnabled') === true ? 'Codex ON' : 'Codex OFF'}
                  onPress={() => saveSetting('codexEnabled', setting('codexEnabled') !== true, 'Codex sidekick')}
                />
                <Text dimColor>Codex sends the task you give it to OpenAI. Read-only. Needs the Codex CLI installed and logged in.</Text>
              </Box>
            </Box>,
            'magenta',
          )}
        </Box>
      )
    }

    if (view === 'help') {
      return (
        <Box flexDirection="column">
          {header}
          {card(
            'What Buddy does',
            <Text>
              I'm your sidekick. I show every chat you have open, your limits, your cache and your agents. I keep your to-do list when Claude needs you, cover your secrets while you film, and ask before Claude sends an email or spends on a paid API.
            </Text>,
            'yellow',
          )}
          {card(
            'When I pop up, you choose',
            <Box flexDirection="column">
              <Text>Send: Send · Send to me first · Approve all today · Cancel</Text>
              <Text>Spend: Approve · Approve all today · Cancel</Text>
              <Text>Delete: Proceed · Cancel</Text>
              <Text dimColor>If my check ever breaks, the answer is no. Type your own answer and Claude reads it as an instruction.</Text>
            </Box>,
          )}
          {card(
            'Commands',
            <Box flexDirection="column">
              <Text>/buddy opens me · /buddy rec turns recording mode on or off · /buddy reset clears the caught counter</Text>
              <Text>/handoff saves a note so a fresh chat picks up where you left off</Text>
              <Text>/thread task starts a separate background chat (see the Threads tab)</Text>
              <Text>/codex task asks Codex for a read-only second opinion (when on)</Text>
            </Box>,
          )}
          {card('Try me', <Text>Press Recording mode, then ask Claude to show your .env. Or ask it to set up something that needs an API key and watch your to-do list.</Text>, 'green')}
          {card(
            "What I can't catch",
            <Text dimColor>
              I know connectors, git, deploys, known paid APIs and web requests. A custom script that sends or spends inside its own code can go around me.
            </Text>,
          )}
        </Box>
      )
    }

    const lims = await read($, limits)
    const fc = await read($, forecast)
    const hhmm = (ms: number) => {
      const d = new Date(ms)
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    }
    const paceLine = (kind: string) => {
      const f = fc.limits[kind]
      if (!f) return ''
      const reset = f.resetsAt ? Date.parse(f.resetsAt) : NaN
      if (f.fullAt && (!Number.isFinite(reset) || f.fullAt < reset)) return `at this pace, runs out around ${hhmm(f.fullAt)}`
      if (Number.isFinite(reset)) return `resets at ${hhmm(reset)}${f.fullAt ? ', before you run out' : ''}`
      return ''
    }
    const usd = await read($, cost)
    const clog = await read($, codexLog)
    const cstat = await read($, codexStatus)
    const last = await read($, lastTurnAt)
    const welcomed = (await $.store.get('welcomed')) === true
    const codexOn = setting('codexEnabled') === true
    const ttl = Math.max(1, Number(setting('cacheMinutes') ?? 60)) * 60000
    const left = last ? last + ttl - Date.now() : 0
    const cacheLine = !last
      ? 'Cache: starts after the first reply'
      : left > 0
        ? `Cache warm: ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')} left`
        : 'Cache cold: your next message re-reads the whole chat'

    return (
      <Box flexDirection="column">
        {header}
        {!welcomed &&
          card(
            'Welcome! Here is how I work',
            <Box flexDirection="column" gap={1}>
              <Text>1. Keep working as normal. I watch all your chats, your limits and your cache.</Text>
              <Text>2. When Claude is stuck waiting on you (a key, a login), it lands on your to-do list here.</Text>
              <Text>3. Filming or sharing your screen? Press Recording mode and I cover your secrets.</Text>
              <Text>4. Before Claude sends an email or spends on a paid API, I ask you first.</Text>
              <Box>
                <Button key="welcome-ok" variant="primary" label="Got it" onPress={async () => { await $.store.set('welcomed', true); await update($, tick, n => n + 1) }} />
              </Box>
            </Box>,
            'green',
          )}
        {todoCard}
        {card(
          'Health',
          <Box flexDirection="column">
            <Text color={tone(mem)}>
              {bar(mem, 16)} {mem}% chat memory{mem >= 80 ? ' · compact soon' : ''}
              {fc.repliesLeft !== null && mem < 80 ? <Text dimColor> · about {fc.repliesLeft} replies until it's full</Text> : null}
            </Text>
            {lims.map(l => (
              <Text color={tone(l.percentUsed)}>
                {bar(l.percentUsed, 16)} {Math.round(l.percentUsed)}% {LIMIT_NAMES[l.kind] ?? l.kind} limit
                {paceLine(l.kind) ? <Text dimColor> · {paceLine(l.kind)}</Text> : null}
              </Text>
            ))}
            <Box gap={2}>
              <Text color={left > 60000 ? 'green' : left > 0 ? 'yellow' : 'gray'}>{cacheLine}</Text>
              <Button
                key="cache-toggle"
                variant={isOn('cacheCheck') ? 'primary' : 'secondary'}
                label={isOn('cacheCheck') ? 'Price check ON' : 'Price check OFF'}
                onPress={() => toggle('cacheCheck')}
              />
            </Box>
            {usd > 0 && <Text dimColor>This chat at API rates: ${usd.toFixed(2)} (not your bill on a subscription)</Text>}
          </Box>,
          'yellow',
        )}
        {boardCard}
        {card(
          'Quick moves',
          <Box flexDirection="column" gap={1}>
            <Box gap={2} flexWrap="wrap">
              <Button key="fable" label="Fable" onPress={() => switchTo('model', 'fable')} />
              <Button key="opus" label="Opus" onPress={() => switchTo('model', 'opus')} />
              <Button key="sonnet" label="Sonnet" onPress={() => switchTo('model', 'sonnet')} />
              <Button key="effort-low" label="Effort low" onPress={() => switchTo('effort', 'low')} />
              <Button key="effort-high" label="Effort high" onPress={() => switchTo('effort', 'high')} />
            </Box>
            <Box gap={2} flexWrap="wrap">
              <Button key="compact" label="Compact now" onPress={compactNow} />
              <Button key="handoff" label="Save handoff note" onPress={handoffNow} />
            </Box>
            <Text dimColor>Models: newest version of each. Compact shrinks this chat. Handoff saves a note so a fresh chat picks up where this one left off.</Text>
          </Box>,
        )}
        {codexOn &&
          card(
            cstat === 'running' ? 'Codex · running' : 'Ask Codex',
            <Box flexDirection="column">
              <Text dimColor>A read-only second opinion from OpenAI Codex. Type a question and press Enter.</Text>
              <Input
                key="ask-codex"
                placeholder="e.g. review notes.md and tell me what's wrong"
                submitLabel="ask"
                onSubmit={async (v: string) => {
                  if (!v.trim()) return
                  try {
                    await $.command.run({ command: 'codex', args: v.trim() })
                  } catch {
                    $.ui.toast('Type /codex followed by your question')
                  }
                }}
              />
              {clog.map(line => (
                <Text dimColor>{line}</Text>
              ))}
            </Box>,
            'magenta',
          )}
        <Text dimColor>Helpers and agents live in Threads. Everything Buddy stepped in on is in Jobs.</Text>
      </Box>
    )
  })
}
