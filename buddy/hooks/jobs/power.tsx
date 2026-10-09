import { atom, read, update } from 'claude-code'

import { maskDeep, maskText, nameList } from '../lib/mask.ts'

// Buddy's shared state (same keys in every file, so every job sees the same values).
const recOn = atom({ plugin: 'buddy', key: 'recOn' } as const, false)
const tick = atom({ plugin: 'buddy', key: 'tick' } as const, 0)

type Options = { hideNames?: string }

export type Todo = { id: string; task: string; doneWhen?: string; sessionId: string; chat: string; at: number; done?: boolean }

// Names to hide on screen: the settings panel wins over the install options.
async function hiddenNames($: any, options: Options): Promise<string[]> {
  const panel = ((await $.store.get('settings')) ?? {}) as Options
  return nameList(panel.hideNames ?? options.hideNames)
}

export function registerPower(on: any, options: Options) {
  // ---------- Recording mode: mask the transcript while you film or share your screen ----------
  // Each hook reads `recOn`, so flipping it redraws every row at once.
  on('ui.render', { component: 'UserMessage' }, async ($: any, e: any, next: any) => {
    if (!(await read($, recOn))) return next(e)
    const names = await hiddenNames($, options)
    return next({ ...e, props: { ...e.props, text: maskText(String(e.props.text ?? ''), names) } })
  })
  on('ui.render', { component: 'AssistantMessage' }, async ($: any, e: any, next: any) => {
    if (!(await read($, recOn))) return next(e)
    const names = await hiddenNames($, options)
    return next({ ...e, props: { ...e.props, text: maskText(String(e.props.text ?? ''), names) } })
  })
  on('ui.render', { component: 'CommandOutput' }, async ($: any, e: any, next: any) => {
    if (!(await read($, recOn))) return next(e)
    const names = await hiddenNames($, options)
    return next({ ...e, props: { ...e.props, text: maskText(String(e.props.text ?? ''), names) } })
  })
  on('ui.render', { component: 'ToolUse' }, async ($: any, e: any, next: any) => {
    if (!(await read($, recOn))) return next(e)
    const names = await hiddenNames($, options)
    const props = { ...e.props, input: maskDeep(e.props.input, names) }
    if (e.props.output !== undefined) props.output = maskDeep(e.props.output, names)
    return next({ ...e, props })
  })
  on('ui.render', { component: 'ToolResult' }, async ($: any, e: any, next: any) => {
    if (!(await read($, recOn))) return next(e)
    const names = await hiddenNames($, options)
    return next({ ...e, props: { ...e.props, output: maskDeep(e.props.output, names) } })
  })

  // ---------- To-do inbox: things only you can do, handed to Buddy instead of buried in a reply ----------
  on('tool.call', { tool: 'mcp__buddy__todo_for_you' }, async ($: any, e: any) => {
    const live = ((await $.store.get('jobs')) ?? {}) as Record<string, boolean>
    if (live.todoInbox === false) return { result: 'The to-do inbox is off in Buddy. Tell the user in your reply instead.' }
    const task = String(e.task ?? '').trim().slice(0, 140)
    if (!task) return { result: 'Give the task in one short sentence.' }
    const sessionId = await $.session.id()
    let chat = ''
    try {
      const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.') as string
      const row = JSON.parse(await $.fs.read(`${home.replace(/\\/g, '/')}/.claude/buddy/chats/${sessionId}.json`))
      chat = row.folder || row.title || ''
    } catch {
      chat = ''
    }
    const todo: Todo = {
      id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
      task,
      doneWhen: e.doneWhen ? String(e.doneWhen).slice(0, 140) : undefined,
      sessionId,
      chat,
      at: Date.now(),
    }
    const list = ((await $.store.get('todos')) ?? []) as Todo[]
    await $.store.set('todos', [...list.filter(t => !t.done && Date.now() - t.at < 86400000), todo].slice(-10))
    await $.ui.open({ id: 'buddy', title: 'Buddy' })
    $.ui.toast(`Buddy: new to-do for you: ${task}`)
    await update($, tick, (n: number) => n + 1)
    return {
      result:
        'Added to the user\'s Buddy to-do list. They press Done when finished and you will get a message saying so. Carry on with anything that does not depend on it; otherwise stop and wait.',
    }
  })
}
