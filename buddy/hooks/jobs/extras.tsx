import { atom, read, update } from 'claude-code'

import type { Limit } from '../../types'

// Buddy's shared state (same keys in every file, so every job sees the same values).
const limits = atom({ plugin: 'buddy', key: 'limits' } as const, [] as Limit[])
const cost = atom({ plugin: 'buddy', key: 'cost' } as const, 0)
const editing = atom({ plugin: 'buddy', key: 'editing' } as const, [] as string[])
const codexLog = atom({ plugin: 'buddy', key: 'codexLog' } as const, [] as string[])
const codexStatus = atom({ plugin: 'buddy', key: 'codexStatus' } as const, '')

type Options = {
  lockedFiles?: string
  houseRules?: string
  codexEnabled?: boolean
  codexModel?: string
}

const list = (text: string | undefined, sep: RegExp) =>
  (text ?? '')
    .split(sep)
    .map(s => s.trim())
    .filter(Boolean)

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()

// A locked entry matches a file name, a path ending, or a folder ("contracts/").
const isLocked = (path: string, locked: string[]) => {
  const p = norm(path)
  return locked.some(raw => {
    const l = norm(raw)
    if (l.endsWith('/')) return p.includes('/' + l) || p.startsWith(l)
    return p === l || p.endsWith('/' + l)
  })
}

const short = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + '…' : text)

// Runs Codex read-only on one task and streams its progress into Buddy's pane.
// Returns Codex's final answer, or why there is none.
async function runCodex($: any, task: string, model: string, cwd: string): Promise<string> {
  await update($, codexStatus, () => 'running')
  await update($, codexLog, () => [`▶ ${short(task, 70)}`])
  let answer = ''
  let buffer = ''
  const run = $.process.spawn({
    argv: ['codex', 'exec', '-m', model, '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '--json', '-C', cwd, task],
    input: '',
  })
  for await (const chunk of run) {
    if (chunk.stream !== 'stdout') continue
    buffer += chunk.text
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      let ev: any
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      const item = ev.item
      if (ev.type === 'item.completed' && item?.type === 'agent_message') {
        answer = String(item.text ?? '')
        await update($, codexLog, l => [...l, `💬 ${short(answer.replace(/\s+/g, ' '), 70)}`].slice(-8))
      } else if (ev.type === 'item.started' && item?.type === 'command_execution') {
        await update($, codexLog, l => [...l, `$ ${short(String(item.command ?? ''), 70)}`].slice(-8))
      } else if (ev.type === 'turn.completed') {
        const used = ev.usage?.input_tokens ?? 0
        await update($, codexLog, l => [...l, `✓ done (${Math.round(used / 1000)}k tokens in)`].slice(-8))
      }
    }
  }
  await update($, codexStatus, () => (answer ? 'done' : 'no answer'))
  return answer || 'Codex finished without an answer. Check that `codex` is installed and logged in.'
}

// Settings saved in Buddy's panel win over the config file.
async function readSettings($: any, options: Options): Promise<Options> {
  return { ...options, ...(((await $.store.get('settings')) ?? {}) as Options) }
}

export function registerExtras(on: any, options: Options) {

  // Locked files and the work receipt both watch file edits.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($: any, e: any, next: any) => {
    const path = String(e.file_path ?? e.notebook_path ?? '')
    const live = ((await $.store.get('jobs')) ?? {}) as Record<string, boolean>
    const locked = list((await readSettings($, options)).lockedFiles, /,/)
    if (live.lockedFiles !== false && path && isLocked(path, locked)) {
      $.ui.toast(`Buddy kept Claude out of a locked file: ${short(path, 60)}`)
      const log = ((await $.store.get('log')) ?? []) as any[]
      await $.store.set('log', [{ at: Date.now(), kind: 'locked', what: `edit ${short(path, 80)}`, choice: 'blocked (locked file)' }, ...log].slice(0, 20))
      return { deny: `${path} is locked in Buddy's settings. Don't edit it; tell the user what you wanted to change.` }
    }
    const ran = await next(e)
    if (path && ran?.deny === undefined && ran?.isError !== true) {
      await update($, editing, files => (files.includes(path) ? files : [...files, path]))
    }
    return ran
  })

  // Limits and cost, pushed after every turn and when a limit moves a point.
  on('session.measure', async ($: any, e: any, next: any) => {
    const before = await read($, limits)
    const now: Limit[] = (e.rateLimits ?? []).map((r: any) => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
    await update($, limits, () => now)
    await update($, cost, () => Number(e.cost?.usd ?? 0))
    for (const r of now) {
      const was = before.find(b => b.kind === r.kind)?.percentUsed ?? 0
      if (r.percentUsed >= 80 && was < 80) $.ui.toast(`Buddy: you've used ${Math.round(r.percentUsed)}% of your ${r.kind} limit`)
    }
    return next(e)
  })

  // House rules ride along with every new chat, unseen.
  {
    on('prompt.context', async ($: any, e: any, next: any) => {
      const got = await next(e)
      const live = ((await $.store.get('jobs')) ?? {}) as Record<string, boolean>
      const rules = list((await readSettings($, options)).houseRules, /[\n;]/)
      const blocks = [...got.blocks]
      if (live.todoInbox !== false) {
        blocks.push({
          name: 'buddy-todo-inbox',
          text:
            'The user runs Buddy, which keeps their to-do list. Whenever something needs the user to act (add or paste an API key or secret, log in, approve or pay for something, install an app, check something by hand, make a decision only they can make), call the mcp__buddy__todo_for_you tool once per task, as well as mentioning it in your reply. Keep each task to one short sentence starting with a verb.',
        })
      }
      if (live.houseRules === false || rules.length === 0) return { ...got, blocks }
      const text = "The user's house rules (from Buddy). Follow them in every reply:\n" + rules.map(r => `- ${r}`).join('\n')
      return { ...got, blocks: [...blocks, { name: 'buddy-house-rules', text }] }
    })
  }

  // Handoff note: a summary of this chat, saved to a file, ready for a fresh chat.
  on('command.run', { command: 'handoff' }, async ($: any, e: any) => {
    const reply = await $.model.fork({
      prompt:
        'Write a handoff note for continuing this work in a fresh chat. Sections: Goal, What is done, Decisions made, Files involved, Next steps, Open questions. Be specific and short. Markdown only.',
    })
    if (!reply.isAnswered) return { text: `Buddy couldn't write a handoff yet (${reply.reason}).` }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const file = `handoff-${stamp}.md`
    await $.fs.write(file, reply.text)
    return { text: `Handoff saved to ${file}. Start a new chat and say: "Read ${file} and continue."` }
  })

  // Codex sidekick: opt-in, read-only.
  {
    on('tool.call', { tool: 'mcp__buddy__codex' }, async ($: any, e: any) => {
      const s = await readSettings($, options)
      if (s.codexEnabled !== true) return { result: 'The Codex sidekick is switched off in Buddy settings.' }
      const answer = await runCodex($, String(e.task ?? ''), (s.codexModel ?? 'gpt-5.5').trim() || 'gpt-5.5', String(e.cwd ?? '.'))
      return { result: answer }
    })

    on('command.run', { command: 'codex' }, async ($: any, e: any) => {
      const task = String(e.args ?? '').trim()
      if (!task) return { text: 'Usage: /codex <task>' }
      const s = await readSettings($, options)
      if (s.codexEnabled !== true) return { text: 'Turn on the Codex sidekick in Buddy > Settings first.' }
      await $.ui.open({ id: 'buddy', title: 'Buddy' })
      const answer = await runCodex($, task, (s.codexModel ?? 'gpt-5.5').trim() || 'gpt-5.5', '.')
      return { text: `Codex says:\n\n${answer}` }
    })
  }
}
