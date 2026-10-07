import { atom, read, update } from 'claude-code'

// Threads: one chat runs a team. Helper agents inside this chat, separate background
// Claude chats, and messages to any other open chat, all managed from Buddy's Threads tab.

export type AgentLive = { tool?: string; steps: number; lastAt: number }
export type AgentMeta = { by: string; model: string; task: string }
export type ChatThread = {
  id: string
  sessionId?: string
  task: string
  model: string
  by: string
  status: 'starting' | 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  lastTool?: string
  answer?: string
  turns: number
}

const agentLive = atom({ plugin: 'buddy', key: 'agentLive' } as const, {} as Record<string, AgentLive>)
const chatThreads = atom({ plugin: 'buddy', key: 'chatThreads' } as const, [] as ChatThread[])
const threadModel = atom({ plugin: 'buddy', key: 'threadModel' } as const, 'sonnet')

type Options = { threadPermission?: string }

const short = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + '…' : text)

async function boardDir($: any): Promise<string> {
  const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.') as string
  return `${home.replace(/\\/g, '/')}/.claude/buddy/chats`
}

// Every open chat from the board files (the same files the Chats tab reads).
async function listBoard($: any): Promise<{ id: string; title: string; folder: string; status: string }[]> {
  const dir = await boardDir($)
  if (!(await $.fs.exists(dir))) return []
  const self = await $.session.id()
  const rows: { id: string; title: string; folder: string; status: string }[] = []
  for (const ent of await $.fs.list(dir)) {
    if (ent.kind !== 'file' || !ent.name.endsWith('.json')) continue
    try {
      const row = JSON.parse(await $.fs.read(`${dir}/${ent.name}`))
      if (row.status !== 'closed' && Date.now() - row.updatedAt < 180000 && row.id !== self) rows.push({ id: row.id, title: row.title ?? '', folder: row.folder ?? '', status: row.status })
    } catch {
      // skip unreadable files
    }
  }
  return rows
}

// Runs one turn of a separate background Claude chat (a fresh one, or the next message to one
// that already exists via --resume) and keeps its row in the Threads tab up to date.
async function runChatThread($: any, id: string, prompt: string, options: Options, tellLead: boolean) {
  const rows = await read($, chatThreads)
  const row = rows.find(r => r.id === id)
  if (!row) return
  const panel = ((await $.store.get('settings')) ?? {}) as Options
  const mode = String(panel.threadPermission ?? options.threadPermission ?? 'acceptEdits').trim() || 'acceptEdits'
  const argv = ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--model', row.model, '--permission-mode', mode]
  if (row.sessionId) argv.push('--resume', row.sessionId)
  argv.push(prompt)
  const set = (patch: Partial<ChatThread>) => update($, chatThreads, (list: ChatThread[]) => list.map(r => (r.id === id ? { ...r, ...patch } : r)))
  await set({ status: 'running', endedAt: undefined })
  let answer = ''
  let failed = ''
  try {
    const child = $.process.spawn({ argv, cwd: await $.session.cwd(), env: { BUDDY_CHILD: '1' }, input: '' })
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
        if (ev.type === 'system' && ev.session_id) await set({ sessionId: ev.session_id })
        if (ev.type === 'assistant') {
          const tools = (ev.message?.content ?? []).filter((c: any) => c.type === 'tool_use').map((c: any) => c.name)
          if (tools.length > 0) await set({ lastTool: tools[tools.length - 1] })
        }
        if (ev.type === 'result') {
          answer = String(ev.result ?? '')
          if (ev.is_error) failed = answer || 'the chat ended with an error'
          if (ev.session_id) await set({ sessionId: ev.session_id })
        }
      }
    }
  } catch (err) {
    failed = String((err as Error)?.message ?? err).slice(0, 200)
  }
  const cur = (await read($, chatThreads)).find(r => r.id === id)
  await set({ status: failed ? 'failed' : 'done', endedAt: Date.now(), answer: short(failed || answer, 4000), turns: (cur?.turns ?? 0) + 1 })
  $.ui.toast(failed ? `Buddy: "${short(row.task, 40)}" failed` : `Buddy: separate chat "${short(row.task, 40)}" finished`)
  if (tellLead) {
    const text = failed
      ? `[Buddy] Separate chat ${id} ("${short(row.task, 60)}") failed: ${short(failed, 400)}`
      : `[Buddy] Separate chat ${id} ("${short(row.task, 60)}") finished. Its answer:\n\n${short(answer, 6000)}`
    try {
      await $.prompt.submit({ text })
    } catch {
      // the answer stays in the Threads tab
    }
  }
}

export function registerThreads(on: any, options: Options) {
  // Live steps for each helper agent: one step per model request in its loop.
  on('turn.step', async function* ($: any, e: any, next: any) {
    if (e.agentId) {
      const id = e.agentId as string
      try {
        await update($, agentLive, (all: Record<string, AgentLive>) => ({ ...all, [id]: { ...(all[id] ?? { steps: 0 }), steps: (all[id]?.steps ?? 0) + 1, lastAt: Date.now() } }))
      } catch {
        // display only
      }
    }
    return yield* next(e)
  })

  // The lead chat's tools: see the other chats, message them, and start separate ones.
  on('tool.call', { tool: 'mcp__buddy__list_chats' }, async ($: any) => {
    const rows = await listBoard($)
    const threads = await read($, chatThreads)
    return {
      result: JSON.stringify({
        openChats: rows,
        separateChatsStartedHere: threads.map(t => ({ id: t.id, task: t.task, model: t.model, status: t.status, answer: t.answer ? short(t.answer, 500) : undefined })),
      }),
    }
  })

  on('tool.call', { tool: 'mcp__buddy__message_chat' }, async ($: any, e: any) => {
    const target = String(e.chatId ?? '').trim()
    const text = String(e.text ?? '').trim()
    if (!target || !text) return { result: 'Give chatId and text.' }
    const threads = await read($, chatThreads)
    const mine = threads.find(t => t.id === target || t.sessionId === target)
    if (mine) {
      if (mine.status === 'running' || mine.status === 'starting') return { result: `Separate chat ${mine.id} is still working. Wait for its answer, then message it.` }
      void runChatThread($, mine.id, text, options, true)
      return { result: `Sent to separate chat ${mine.id}. Its reply will arrive as a new message from Buddy.` }
    }
    const sent = await $.session.send({ to: { sessionId: target }, text: `[from another chat, via Buddy] ${text}` })
    $.ui.toast(sent.isDelivered ? 'Buddy delivered your message' : `Buddy couldn't deliver it: ${sent.reason}`)
    return { result: sent.isDelivered ? 'Delivered to that chat.' : `Not delivered: ${sent.reason}` }
  })

  // /thread <task> starts a separate chat from the panel; /thread msg <id> <text> sends it the next message.
  on('command.run', { command: 'thread' }, async ($: any, e: any) => {
    const args = String(e.args ?? '').trim()
    const m = args.match(/^msg\s+(\S+)\s+([\s\S]+)$/)
    if (m) {
      const row = (await read($, chatThreads)).find(r => r.id === m[1])
      if (!row) return { text: `No separate chat called ${m[1]}.` }
      if (row.status === 'running' || row.status === 'starting') return { text: 'That chat is still working. Message it when it finishes.' }
      void runChatThread($, row.id, m[2], options, false)
      return { text: `Sent to ${row.id}.` }
    }
    if (!args) return { text: 'Usage: /thread <task>  ·  /thread msg <id> <text>' }
    const model = await read($, threadModel)
    const id = `t${Date.now().toString(36).slice(-5)}`
    await update($, chatThreads, (list: ChatThread[]) => [...list, { id, task: short(args, 300), model, by: 'you', status: 'starting' as const, startedAt: Date.now(), turns: 0 }].slice(-12))
    void runChatThread($, id, args, options, false)
    return { text: `Started separate chat ${id} on ${model}. Watch it in Buddy's Threads tab.` }
  })

  on('tool.call', { tool: 'mcp__buddy__start_chat' }, async ($: any, e: any) => {
    const task = String(e.task ?? '').trim()
    if (!task) return { result: 'Give the task.' }
    const model = String(e.model ?? 'sonnet').trim() || 'sonnet'
    const id = `t${Date.now().toString(36).slice(-5)}`
    await update($, chatThreads, (list: ChatThread[]) => [...list, { id, task: short(task, 300), model, by: 'Claude', status: 'starting' as const, startedAt: Date.now(), turns: 0 }].slice(-12))
    await $.ui.open({ id: 'buddy', title: 'Buddy' })
    void runChatThread($, id, task, options, true)
    return {
      result: `Started separate chat ${id} on ${model}. It runs in the background; its answer will arrive as a new message from Buddy. Message it later with mcp__buddy__message_chat using chatId "${id}". Carry on meanwhile.`,
    }
  })
}
