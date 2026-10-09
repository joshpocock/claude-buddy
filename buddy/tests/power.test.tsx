import { expect, mock, test } from 'claude-code/testing'

const setup = (on: any, entries: Record<string, unknown> = {}, mockFs = true) => {
  mock.clock(on)
  mock.store(on, entries)
  mock.env(on, { USERPROFILE: 'C:/buddy-test' })
  if (mockFs) on('fs.exists', async () => ({ value: false }))
  on('ui.toast', async () => ({ value: undefined }))
  // The engine's own drawing of a transcript row: hand back the props the plugin passed down.
  on('ui.render', { component: 'AssistantMessage' }, async (t$: any, e: any) => {
    const { Text } = t$.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
}

test('panel draws, recording mode switches on, and the transcript gets masked', async ($: any, on: any) => {
  setup(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'buddy', surface, component: 'Pane', requestId: 'buddy', props: {} } as any)
    expect(await ui.find({ key: 'rec-switch' })).toBeDefined()
    await ui.press({ key: 'rec-switch' })
    const masked: any = await $.ui.render({ component: 'AssistantMessage', surface, props: { text: 'Your key is sk-proj-abcDEF1234567890abcdefXYZ, email josh@example.com', isFirstOfReply: true } } as any)
    const flat = JSON.stringify(masked)
    expect(flat.includes('█')).toBe(true)
    expect(flat.includes('sk-proj-abc')).toBe(false)
    expect(flat.includes('josh@example.com')).toBe(false)
    await ui.press({ key: 'rec-switch' })
    await ui.unmount()
  }
})

test('to-do card shows a task Claude added, and Skip clears it', async ($: any, on: any) => {
  setup(on, { todos: [{ id: 't1', task: 'Add your OpenAI key to .env', sessionId: 'other', chat: 'demo', at: Date.now() }] })
  const ui = await $.ui.mount({ plugin: 'buddy', surface: 'terminal', component: 'Pane', requestId: 'buddy', props: {} } as any)
  expect(await ui.find({ key: 'todo-done-t1' })).toBeDefined()
  expect(await ui.find({ key: 'todo-done-all' })).toBeDefined()
  await ui.press({ key: 'todo-skip-t1' })
  expect(await ui.find({ key: 'todo-done-t1' })).toBeUndefined()
  await ui.unmount()
})

test('Threads tab starts a helper, lists it with its live tool, and stops it', async ($: any, on: any) => {
  setup(on)
  const spawned: any[] = []
  const stopped: string[] = []
  on('agent.spawn', async (_$: any, e: any) => {
    spawned.push(e)
    return { model: e.model ?? 'sonnet', agentId: 'a1' }
  })
  on('agent.list', async () => ({ value: spawned.length ? [{ id: 'a1', description: 'research competitors', type: 'general-purpose', status: 'running' }] : [] }))
  on('tool.call', { tool: 'TaskStop' }, async (_$: any, e: any) => {
    stopped.push(String(e.task_id))
    return { result: 'stopped' }
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    spawned.length = 0
    const ui = await $.ui.mount({ plugin: 'buddy', surface, component: 'Pane', requestId: 'buddy', props: {} } as any)
    await ui.press({ key: 'tab-threads' })
    await ui.press({ key: 'model-opus' })
    await ui.input({ key: 'thread-task', text: 'research competitors' })
    expect(spawned.length).toBe(1)
    expect(spawned[0].model).toBe('opus')
    expect(await ui.find({ key: 'stop-a1' })).toBeDefined()
    await ui.press({ key: 'stop-a1' })
    expect(stopped.includes('a1')).toBe(true)
    await ui.unmount()
  }
})

test('cache price check switches off and on from the Health card', async ($: any, on: any) => {
  setup(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'buddy', surface, component: 'Pane', requestId: 'buddy', props: {} } as any)
    expect((await ui.find({ key: 'cache-toggle' }))?.props?.label ?? 'Price check ON').toBe('Price check ON')
    await ui.press({ key: 'cache-toggle' })
    expect((await ui.find({ key: 'cache-toggle' }))?.props?.label).toBe('Price check OFF')
    await ui.press({ key: 'cache-toggle' })
    expect((await ui.find({ key: 'cache-toggle' }))?.props?.label).toBe('Price check ON')
    await ui.unmount()
  }
})

test('Skills tab lists project and global skills with use counts and offers the right moves', async ($: any, on: any) => {
  setup(on, { skillUse: { 'hook-generator': { count: 3, last: 1 } }, skillUseSince: 1 }, false)
  const isSkillsDir = (p: unknown) => String(p).replace(/\\/g, '/').endsWith('/.claude/skills')
  on('fs.exists', async (_$: any, e: any) => ({ value: isSkillsDir(e.path) }))
  on('fs.list', async (_$: any, e: any) =>
    ({ value: isSkillsDir(e.path) ? [{ name: 'hook-generator', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }, { name: 'old-thing', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] : [] }))
  on('session.cwd', async () => ({ value: 'C:/proj' }))
  on('fs.read', async (_$: any, e: any) => ({ value: `---\nname: ${String(e.path).includes('old-thing') ? 'old-thing' : 'hook-generator'}\ndescription: |\n  Writes hooks.\n---\n` }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'buddy', surface, component: 'Pane', requestId: 'buddy', props: {} } as any)
    await ui.press({ key: 'tab-skills' })
    expect(await ui.find({ key: 'sopen-project:hook-generator' })).toBeDefined()
    expect(await ui.find({ key: 'sopen-global:old-thing' })).toBeDefined()
    await ui.press({ key: 'sopen-project:hook-generator' })
    expect(await ui.find({ key: 'sm-project:hook-generator' })).toBeDefined()
    expect(await ui.find({ key: 'sh-project:hook-generator' })).toBeUndefined()
    await ui.press({ key: 'sopen-global:old-thing' })
    expect(await ui.find({ key: 'sh-global:old-thing' })).toBeDefined()
    await ui.unmount()
  }
})

test('Status is four tidy cards; activity and the counter live in Jobs', async ($: any, on: any) => {
  setup(on, { welcomed: true, log: [{ at: 1, kind: 'send', what: 'email to me', choice: 'Cancel' }] })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'buddy', surface, component: 'Pane', requestId: 'buddy', props: {} } as any)
    await ui.press({ key: 'tab-status' })
    for (const key of ['cache-toggle', 'sonnet', 'effort-low', 'compact', 'handoff']) if (!(await ui.find({ key }))) throw new Error('missing ' + key)
    expect(await ui.find({ key: 'reset' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Agents/ })).toBeUndefined()
    await ui.press({ key: 'tab-jobs' })
    if (!(await ui.find({ key: 'reset' }))) throw new Error('no reset in jobs')
    if (!(await ui.find({ type: 'Text', text: /email to me/ }))) throw new Error('no activity row')
    await ui.unmount()
  }
})
