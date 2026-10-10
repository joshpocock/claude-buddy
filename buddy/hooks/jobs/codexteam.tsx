import { atom, read, update } from 'claude-code'

import { dayDirs, dumpArgv, idFromFile, parseDump, parseIndex } from '../lib/codexthreads.ts'
import type { CodexThread } from '../lib/codexthreads.ts'

// Codex team: Claude (and you) start Codex agents, message any Codex thread, and watch them work.
// Codex runs through its own CLI. Buddy always passes the sandbox explicitly: read-only unless you
// approve file edits for that one run, because a user's Codex config may default to full access.

export type CodexJob = {
  id: string
  threadId?: string
  task: string
  model: string
  canEdit: boolean
  by: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  lastAction?: string
  answer?: string
  tokens?: number
  turns: number
}

const codexJobs = atom({ plugin: 'buddy', key: 'codexJobs' } as const, [] as CodexJob[])

const short = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + '…' : text)

type Options = { codexEnabled?: boolean; codexModel?: string }

async function codexOn($: any, options: Options): Promise<boolean> {
  const panel = ((await $.store.get('settings')) ?? {}) as Options
  return (panel.codexEnabled ?? options.codexEnabled) === true
}

async function defaultModel($: any, options: Options): Promise<string> {
  const panel = ((await $.store.get('settings')) ?? {}) as Options
  return String(panel.codexModel ?? options.codexModel ?? 'gpt-5.5').trim() || 'gpt-5.5'
}


// Your recent Codex threads (app and CLI), newest first: name, folder, working or idle, last reply.
async function scanCodexThreads($: any, limit = 15): Promise<CodexThread[]> {
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
  const recent = files.sort((a, b) => b.mtime - a.mtime).slice(0, limit)
  if (recent.length === 0) return []
  let names: Record<string, string> = {}
  try {
    names = parseIndex(await $.fs.read(`${home}/.codex/session_index.jsonl`))
  } catch {
    names = {}
  }
  const r = await $.process.run(dumpArgv(windows, recent.map(f => f.path)), { timeoutMs: 60000 })
  const threads = parseDump(String(r.stdout ?? ''), names, Object.fromEntries(recent.map(f => [f.id, f.mtime])))
  await $.store.set('codexThreads', threads)
  return threads
}

// One Codex turn: a new agent, or the next message to an existing thread (codex exec resume).
async function runCodexJob($: any, jobId: string, prompt: string, tellLead: boolean): Promise<CodexJob | undefined> {
  const job = (await read($, codexJobs)).find(j => j.id === jobId)
  if (!job) return undefined
  const sandbox = job.canEdit ? 'workspace-write' : 'read-only'
  const argv = job.threadId
    ? ['codex', 'exec', 'resume', '-m', job.model, '-c', `sandbox_mode="${sandbox}"`, '--skip-git-repo-check', '--json', job.threadId, prompt]
    : ['codex', 'exec', '-m', job.model, '-s', sandbox, '--skip-git-repo-check', '--json', '-C', await $.session.cwd(), prompt]
  const set = (patch: Partial<CodexJob>) => update($, codexJobs, (list: CodexJob[]) => list.map(j => (j.id === jobId ? { ...j, ...patch } : j)))
  await set({ status: 'running', endedAt: undefined, lastAction: 'starting Codex' })
  let answer = ''
  let failed = ''
  let tokens = 0
  try {
    const child = $.process.spawn({ argv, input: '' })
    let buffer = ''
    for await (const piece of child) {
      if (piece.stream !== 'stdout' || typeof piece.text !== 'string') continue
      buffer += piece.text
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        let ev: any
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        const item = ev.item ?? {}
        if (ev.type === 'thread.started' && ev.thread_id) await set({ threadId: ev.thread_id, lastAction: 'thinking' })
        else if (ev.type === 'item.started' && item.type === 'command_execution') await set({ lastAction: `running: ${short(String(item.command ?? ''), 60)}` })
        else if (ev.type === 'item.completed' && item.type === 'file_change') await set({ lastAction: 'edited files' })
        else if (ev.type === 'item.completed' && item.type === 'web_search') await set({ lastAction: 'reading the web' })
        else if (ev.type === 'item.completed' && item.type === 'agent_message') {
          answer = String(item.text ?? '')
          await set({ lastAction: 'writing its answer' })
        } else if (ev.type === 'turn.completed') tokens = Number(ev.usage?.input_tokens ?? 0) + Number(ev.usage?.output_tokens ?? 0)
        else if (ev.type === 'turn.failed' || ev.type === 'error') failed = String(ev.error?.message ?? ev.message ?? 'Codex reported an error')
      }
    }
  } catch (err) {
    failed = String((err as Error)?.message ?? err).slice(0, 200)
  }
  if (!answer && !failed) failed = 'Codex ended without an answer'
  const cur = (await read($, codexJobs)).find(j => j.id === jobId)
  await set({ status: failed ? 'failed' : 'done', endedAt: Date.now(), answer: short(failed || answer, 6000), tokens: (cur?.tokens ?? 0) + tokens, turns: (cur?.turns ?? 0) + 1, lastAction: failed ? 'failed' : 'done' })
  $.ui.toast(failed ? `Buddy: Codex "${short(job.task, 40)}" failed` : `Buddy: Codex finished "${short(job.task, 40)}"`)
  if (tellLead) {
    const tid = (await read($, codexJobs)).find(j => j.id === jobId)?.threadId ?? ''
    const text = failed
      ? `[Buddy] Codex agent ${jobId} (thread ${tid}) failed: ${short(failed, 400)}`
      : `[Buddy] Codex agent ${jobId} (thread ${tid}) finished "${short(job.task, 80)}". Its answer:\n\n${short(answer, 6000)}`
    try {
      await $.prompt.submit({ text })
    } catch {
      // the answer stays in the Codex tab
    }
  }
  return (await read($, codexJobs)).find(j => j.id === jobId)
}

async function newJob($: any, task: string, model: string, canEdit: boolean, by: string, threadId?: string): Promise<string> {
  const id = `c${Date.now().toString(36).slice(-5)}`
  await update($, codexJobs, (list: CodexJob[]) =>
    [...list, { id, threadId, task: short(task, 300), model, canEdit, by, status: 'running' as const, startedAt: Date.now(), turns: 0 }].slice(-15),
  )
  return id
}

// Asking before Codex may edit files. Anything other than a clear yes keeps it read-only.
async function approveEdits($: any, what: string): Promise<boolean> {
  try {
    const answer = await $.ui.ask(`Let Codex edit files in this project for "${short(what, 80)}"? It can change and create files here. No keeps it read-only.`, ['Yes, let it edit', 'No, read-only'])
    return answer === 'Yes, let it edit'
  } catch {
    return false
  }
}

export function registerCodexTeam(on: any, options: Options) {
  const off = 'Codex is switched off in Buddy (Settings > Codex). Ask the user to turn it on.'

  on('tool.call', { tool: 'mcp__buddy__codex_start' }, async ($: any, e: any) => {
    if (!(await codexOn($, options))) return { result: off }
    const task = String(e.task ?? '').trim()
    if (!task) return { result: 'Give the task.' }
    const model = String(e.model ?? '').trim() || (await defaultModel($, options))
    const canEdit = e.canEdit === true ? await approveEdits($, task) : false
    const id = await newJob($, task, model, canEdit, 'Claude')
    await $.ui.open({ id: 'buddy', title: 'Buddy' })
    if (e.wait === true) {
      const job = await runCodexJob($, id, task, false)
      return { result: `Codex agent ${id} (thread ${job?.threadId ?? '?'}) ${job?.status}:\n\n${job?.answer ?? ''}` }
    }
    void runCodexJob($, id, task, true)
    return { result: `Started Codex agent ${id} on ${model}${canEdit ? ' (may edit files)' : ' (read-only)'}. Its answer arrives later as a message from Buddy. Message it with mcp__buddy__codex_message.` }
  })

  on('tool.call', { tool: 'mcp__buddy__codex_message' }, async ($: any, e: any) => {
    if (!(await codexOn($, options))) return { result: off }
    const target = String(e.threadId ?? '').trim()
    const text = String(e.text ?? '').trim()
    if (!target || !text) return { result: 'Give threadId (a Codex thread id or a Buddy agent id) and text.' }
    const jobs = await read($, codexJobs)
    const known = jobs.find(j => j.id === target || j.threadId === target)
    if (known?.status === 'running') return { result: `Codex agent ${known.id} is still working. Wait for its answer first.` }
    const id = known?.id ?? (await newJob($, text, await defaultModel($, options), false, 'Claude', target))
    if (e.wait === true) {
      const job = await runCodexJob($, id, text, false)
      return { result: `Codex ${job?.status}:\n\n${job?.answer ?? ''}` }
    }
    void runCodexJob($, id, text, true)
    return { result: `Sent to Codex (${known ? `agent ${id}` : `thread ${target}`}). Its reply arrives as a message from Buddy.` }
  })

  on('tool.call', { tool: 'mcp__buddy__codex_threads' }, async ($: any) => {
    let scan: CodexThread[] = []
    try {
      scan = await scanCodexThreads($)
    } catch {
      scan = ((await $.store.get('codexThreads')) ?? []) as CodexThread[]
    }
    const jobs = await read($, codexJobs)
    return {
      result: JSON.stringify({
        startedFromHere: jobs.map(j => ({ id: j.id, threadId: j.threadId, task: j.task, status: j.status, lastAction: j.lastAction, answer: j.answer ? short(j.answer, 400) : undefined })),
        recentCodexThreads: scan,
      }),
    }
  })

  // The panel's buttons: /buddy-codex start <model> <edit|read> <task> · msg <threadId> <text>
  on('command.run', { command: 'buddy-codex' }, async ($: any, e: any) => {
    if (!(await codexOn($, options))) return { text: 'Turn Codex on in Buddy > Settings first.' }
    const args = String(e.args ?? '').trim()
    if (args === 'scan') {
      const threads = await scanCodexThreads($)
      return { text: `Buddy found ${threads.length} recent Codex threads.` }
    }
    const start = args.match(/^start\s+(\S+)\s+(edit|read)\s+([\s\S]+)$/)
    if (start) {
      const canEdit = start[2] === 'edit' ? await approveEdits($, start[3]) : false
      const id = await newJob($, start[3], start[1], canEdit, 'you')
      void runCodexJob($, id, start[3], false)
      return { text: `Started Codex agent ${id} on ${start[1]}${canEdit ? ' (may edit files)' : ' (read-only)'}.` }
    }
    const msg = args.match(/^msg\s+(\S+)\s+([\s\S]+)$/)
    if (msg) {
      const jobs = await read($, codexJobs)
      const known = jobs.find(j => j.id === msg[1] || j.threadId === msg[1])
      if (known?.status === 'running') return { text: 'That Codex agent is still working.' }
      const id = known?.id ?? (await newJob($, msg[2], await defaultModel($, options), false, 'you', msg[1]))
      void runCodexJob($, id, msg[2], false)
      return { text: `Sent to Codex.` }
    }
    return { text: 'Usage: /buddy-codex start <model> <edit|read> <task>  ·  /buddy-codex msg <threadId> <text>' }
  })
}
