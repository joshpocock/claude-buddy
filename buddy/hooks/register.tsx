import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { registerExtras } from './jobs/extras.tsx'
import { registerGuards } from './jobs/guards.tsx'
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
const tab = atom({ plugin: 'buddy', key: 'tab' } as const, 'status' as 'status' | 'jobs' | 'pets' | 'settings' | 'help')

// The pets Buddy can be. A new install starts as an egg that hatches into a random one.
const SPECIES = ['bunny', 'cat', 'dog', 'bear', 'frog', 'owl', 'ghost', 'dragon'] as const
type PetInfo = { stage: 'egg' | 'pet'; species: (typeof SPECIES)[number]; name: string; pets: number }
const NEW_PET: PetInfo = { stage: 'egg', species: 'bunny', name: 'Buddy', pets: 0 }
const lastTurnAt = atom({ plugin: 'buddy', key: 'lastTurnAt' } as const, 0)

// Buddy: Claude Code's old pet, back with real jobs.
// Jobs live in ./jobs; this file draws Buddy and wires the jobs in.

const PANE = 'buddy'

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
  { id: 'agentWatcher', group: 'Watches', name: 'Agent watcher', what: 'Lists every helper agent, running or done, with times', live: true },
  { id: 'donePing', group: 'Watches', name: 'Done ping', what: 'Pops up when a long task finishes, so you can walk away', live: true },
  { id: 'houseRules', group: 'Helps', name: 'House rules', what: 'Reminds Claude of your rules and flags banned words in replies', live: true },
  { id: 'codex', group: 'Helps', name: 'Codex sidekick', what: 'Ask Codex for a read-only second opinion: /codex <task>. Turn on in settings (sends the task to OpenAI)', live: false },
]

const LIMIT_NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly', '5h': '5-hour', '7d': 'weekly' }

export const register: Register = (on, options) => {
  const o = options as any
  registerGuards(on, o)
  registerWatch(on, o)
  registerExtras(on, o)

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
    return (
      <Box>
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
        <Text dimColor>
          Saved you from {total(c)} risky action{total(c) === 1 ? '' : 's'} · I pop up when Claude tries to send, spend or delete.
        </Text>
        <Box gap={2} marginTop={1}>
          <Button key="tab-status" variant={view === 'status' ? 'primary' : 'secondary'} label="Status" onPress={() => update($, tab, () => 'status')} />
          <Button key="tab-jobs" variant={view === 'jobs' ? 'primary' : 'secondary'} label="Jobs" onPress={() => update($, tab, () => 'jobs')} />
          <Button key="tab-pets" variant={view === 'pets' ? 'primary' : 'secondary'} label="Pets" onPress={() => update($, tab, () => 'pets')} />
          <Button key="tab-settings" variant={view === 'settings' ? 'primary' : 'secondary'} label="Settings" onPress={() => update($, tab, () => 'settings')} />
          <Button key="tab-help" variant={view === 'help' ? 'primary' : 'secondary'} label="Help" onPress={() => update($, tab, () => 'help')} />
        </Box>
      </Box>
    )

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
          <Text dimColor>Press ON/OFF to switch a job. It takes effect right away.</Text>
          <Text> </Text>
          {group('Guards', 'red')}
          {group('Watches', 'cyan')}
          {group('Helps', 'magenta')}
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
              {field('paidApis', 'Extra paid APIs', 'Comma-separated hosts the spend gate should also hold.', 'api.stripe.com, api.twilio.com')}
            </Box>,
            'red',
          )}
          {card(
            'Helps',
            <Box flexDirection="column">
              {field('houseRules', 'House rules', 'Rules Claude gets at the start of each new chat. Separate with ;', 'Never use em dashes; Always cite sources')}
              {field('bannedPhrases', 'Banned words', 'Buddy flags a reply that uses any of these. Comma-separated.', 'delve, synergy')}
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
              I work on my own. When Claude tries to send, spend or delete something, I stop it and ask you first. The rest of the time I keep an eye on memory, limits, the cache, agents and your files.
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
              <Text>/buddy opens me · /buddy reset clears the caught counter</Text>
              <Text>/handoff saves a note so a fresh chat picks up where you left off</Text>
              <Text>/codex task asks Codex for a read-only second opinion (when on)</Text>
            </Box>,
          )}
          {card('Try me', <Text>Ask Claude to delete a test folder with rm -rf, or to email yourself.</Text>, 'green')}
          {card(
            "What I can't catch",
            <Text dimColor>
              I know connectors, git, deploys, known paid APIs and web requests. A custom script that sends or spends inside its own code can go around me.
            </Text>,
          )}
        </Box>
      )
    }

    const list = await read($, agents)
    const held = await read($, lastHeld)
    const lims = await read($, limits)
    const usd = await read($, cost)
    const rec = await read($, receipt)
    const clog = await read($, codexLog)
    const cstat = await read($, codexStatus)
    const last = await read($, lastTurnAt)
    const welcomed = (await $.store.get('welcomed')) === true
    const log = ((await $.store.get('log')) ?? []) as { at: number; kind: string; what: string; choice: string }[]
    const appr = ((await $.store.get('approvals')) ?? { date: '', targets: [] }) as { date: string; targets: string[] }
    const todayKey = new Date().toISOString().slice(0, 10)
    const approvedNow = appr.date === todayKey ? appr.targets : []
    const undoApproval = async (target: string) => {
      await $.store.set('approvals', { date: todayKey, targets: approvedNow.filter(x => x !== target) })
      $.ui.toast('Buddy will ask about that again')
      await update($, tick, n => n + 1)
    }
    const codexOn = setting('codexEnabled') === true
    const clock = (at: number) => {
      const d = new Date(at)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }
    const KIND_LABEL: Record<string, string> = { send: 'send', spend: 'paid call', danger: 'delete', locked: 'locked file' }
    const ttl = Math.max(1, Number(o.cacheMinutes ?? 5)) * 60000
    const left = last ? last + ttl - Date.now() : 0
    const cacheLine = !last
      ? 'Cache: starts after the first reply'
      : left > 0
        ? `Cache warm: ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')} left`
        : 'Cache cold: your next message re-reads the whole chat'
    const running = list.filter(r => r.endedAt === undefined).length

    const action = (key: string, label: string, onPress: () => any, what: string) => (
      <Box gap={2}>
        <Box width={18}>
          <Button key={key} label={label} onPress={onPress} />
        </Box>
        <Text dimColor>{what}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {header}
        {!welcomed &&
          card(
            'Welcome! Here is how I work',
            <Box flexDirection="column" gap={1}>
              <Text>1. Keep working as normal. I watch in the background.</Text>
              <Text>2. If Claude tries to send, spend money or delete something, I pop up and you choose.</Text>
              <Text>3. Try it: ask Claude to delete a test folder with rm -rf, then press Cancel.</Text>
              <Text dimColor>Jobs turns things on and off · Settings sets your email and locked files · Pets lets you pick your pet.</Text>
              <Box>
                <Button key="welcome-ok" variant="primary" label="Got it" onPress={async () => { await $.store.set('welcomed', true); await update($, tick, n => n + 1) }} />
              </Box>
            </Box>,
            'green',
          )}
        {card(
          'Health',
          <Box flexDirection="column">
            <Text color={tone(mem)}>
              {bar(mem, 16)} {mem}% chat memory{mem >= 80 ? ' · compact soon' : ''}
            </Text>
            {lims.map(l => (
              <Text color={tone(l.percentUsed)}>
                {bar(l.percentUsed, 16)} {Math.round(l.percentUsed)}% {LIMIT_NAMES[l.kind] ?? l.kind} limit
              </Text>
            ))}
            <Text color={left > 60000 ? 'green' : left > 0 ? 'yellow' : 'gray'}>{cacheLine}</Text>
            {usd > 0 && <Text dimColor>This chat at API rates: ${usd.toFixed(2)} (not your bill on a subscription)</Text>}
          </Box>,
          'yellow',
        )}
        {card(
          'Saved you from',
          <Box flexDirection="column">
            <Box gap={4}>
              <Box flexDirection="column" alignItems="center">
                <Text bold color="red">{c.send}</Text>
                <Text dimColor>sends held</Text>
              </Box>
              <Box flexDirection="column" alignItems="center">
                <Text bold color="red">{c.spend}</Text>
                <Text dimColor>paid calls held</Text>
              </Box>
              <Box flexDirection="column" alignItems="center">
                <Text bold color="red">{c.danger}</Text>
                <Text dimColor>deletes stopped</Text>
              </Box>
            </Box>
            <Text dimColor>Each number counts a time Claude tried to send, spend or delete and Buddy asked you first.</Text>
            <Text dimColor>Last one: {held || 'nothing yet'}</Text>
          </Box>,
          'red',
        )}
        {approvedNow.length > 0 &&
          card(
            'Approved for today',
            <Box flexDirection="column" gap={1}>
              <Text dimColor>These won't ask again until tomorrow. Undo to be asked again.</Text>
              {approvedNow.map(target => (
                <Box gap={2}>
                  <Button key={`undo-${target}`} label="Undo" onPress={() => undoApproval(target)} />
                  <Text>{target.replace(/^(mcp|host|cli|shell|git|gh|vercel|fly|npm):/, '')}</Text>
                </Box>
              ))}
            </Box>,
            'yellow',
          )}
        {card(
          'Activity',
          <Box flexDirection="column">
            {log.length === 0 && <Text dimColor>Nothing yet. Every time I step in, it shows up here with what you chose.</Text>}
            {log.slice(0, 8).map(entry => (
              <Text>
                <Text dimColor>{clock(entry.at)} </Text>
                <Text bold>{KIND_LABEL[entry.kind] ?? entry.kind}</Text>
                <Text dimColor> {entry.what.slice(0, 60)}{entry.what.length > 60 ? '…' : ''} → </Text>
                <Text color={/cancel|block/i.test(entry.choice) ? 'red' : 'green'}>{entry.choice}</Text>
              </Text>
            ))}
          </Box>,
        )}
        {card(
          running > 0 ? `Agents · ${running} running` : 'Agents',
          <Box flexDirection="column">
            {list.length === 0 && <Text dimColor>None yet. Helper agents Claude starts show up here.</Text>}
            {list.map(row => (
              <Text dimColor={row.endedAt !== undefined} color={row.endedAt === undefined ? 'cyan' : undefined}>
                {row.endedAt === undefined ? '● running' : '✓ done   '} {elapsed(row, now)} {row.task}
              </Text>
            ))}
          </Box>,
          'cyan',
        )}
        {rec &&
          card(
            'Last task',
            <Text dimColor>
              {rec.files.length} file{rec.files.length === 1 ? '' : 's'} changed in {rec.seconds}s: {rec.files.slice(0, 4).map(baseName).join(', ')}
              {rec.files.length > 4 ? '…' : ''}
            </Text>,
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
        {card(
          'Do something',
          <Box flexDirection="column" gap={1}>
            {action('compact', 'Compact now', compactNow, 'Shrinks this chat into a summary so Claude stays sharp and uses less of your limit')}
            {action('handoff', 'Save handoff note', handoffNow, 'Writes a summary file so a brand new chat can pick up exactly where this one left off')}
            {action('reset', 'Reset counter', resetCount, 'Sets the "saved you from" numbers back to zero')}
          </Box>,
        )}
        {card(
          'Switch model',
          <Box flexDirection="column">
            <Box gap={2} flexWrap="wrap">
              <Button key="fable" label="Fable" onPress={() => switchTo('model', 'fable')} />
              <Button key="opus" label="Opus" onPress={() => switchTo('model', 'opus')} />
              <Button key="sonnet" label="Sonnet" onPress={() => switchTo('model', 'sonnet')} />
            </Box>
            <Box gap={2} marginTop={1} flexWrap="wrap">
              <Button key="effort-low" label="Effort low" onPress={() => switchTo('effort', 'low')} />
              <Button key="effort-high" label="Effort high" onPress={() => switchTo('effort', 'high')} />
            </Box>
            <Text dimColor>Each model button picks its newest version. Lower effort is faster and lighter on your limit.</Text>
          </Box>,
        )}
      </Box>
    )
  })
}
