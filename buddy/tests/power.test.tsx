import { expect, mock, test } from 'claude-code/testing'

const setup = (on: any, entries: Record<string, unknown> = {}, mockFs = true) => {
  const clock = mock.clock(on)
  mock.store(on, entries)
  mock.env(on, { USERPROFILE: 'C:/buddy-test' })
  if (mockFs) on('fs.exists', async () => ({ value: false }))
  on('ui.toast', async () => ({ value: undefined }))
  // The engine's own drawing of a transcript row: hand back the props the plugin passed down.
  on('ui.render', { component: 'AssistantMessage' }, async (t$: any, e: any) => {
    const { Text } = t$.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  return clock
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

test('recording mode hides skill names in the Skills tab', async ($: any, on: any) => {
  setup(on, {}, false)
  const isSkillsDir = (p: unknown) => String(p).replace(/\\/g, '/').endsWith('/.claude/skills')
  on('fs.exists', async (_$: any, e: any) => ({ value: isSkillsDir(e.path) }))
  on('fs.list', async (_$: any, e: any) => ({ value: isSkillsDir(e.path) ? [{ name: 'secret-sauce', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] : [] }))
  on('session.cwd', async () => ({ value: 'C:/proj' }))
  on('fs.read', async () => ({ value: '---\nname: secret-sauce\ndescription: My private method.\n---\n' }))
  const ui = await $.ui.mount({ plugin: 'buddy', surface: 'terminal', component: 'Pane', requestId: 'buddy', props: {} } as any)
  await ui.press({ key: 'rec-switch' })
  await ui.press({ key: 'tab-skills' })
  if (!(await ui.find({ key: 'sopen-project:secret-sauce' }))) throw new Error('row missing')
  if (await ui.find({ type: 'Text', text: /secret-sauce/ })) throw new Error('name visible while recording')
  if (await ui.find({ type: 'Text', text: /in this project/ })) throw new Error('count visible while recording')
  await ui.unmount()
})

test('Codex tab: off until switched on, then starts a read-only Codex agent', async ($: any, on: any) => {
  setup(on)
  const runs: string[][] = []
  on('process.run', async (_$: any, e: any) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('command.run', { command: 'buddy-codex' }, async (_$: any, e: any) => {
    runs.push(['buddy-codex', String(e.args)])
    return { text: 'ok' }
  })
  const ui = await $.ui.mount({ plugin: 'buddy', surface: 'terminal', component: 'Pane', requestId: 'buddy', props: {} } as any)
  await ui.press({ key: 'tab-codex' })
  if (!(await ui.find({ key: 'cx-on' }))) throw new Error('no turn-on button while off')
  await ui.press({ key: 'cx-on' })
  if (!(await ui.find({ key: 'cx-task' }))) throw new Error('no start box after turning on')
  await ui.input({ key: 'cx-task', text: 'review notes.md' })
  const sent = runs.find(r => r[0] === 'buddy-codex')
  if (!sent || !/^start \S+ read review notes\.md$/.test(sent[1])) throw new Error('start not sent read-only: ' + JSON.stringify(sent))
  await ui.unmount()
})

test('Codex threads are grouped by project with Show all', async ($: any, on: any) => {
  const clock = setup(on, { settings: { codexEnabled: true } }, false)
  const ids = ['01a10000-0000-7000-8000-000000000001', '01a10000-0000-7000-8000-000000000002', '01a10000-0000-7000-8000-000000000003', '01a10000-0000-7000-8000-000000000004', '01a10000-0000-7000-8000-000000000005']
  const today = new Date()
  const dayDir = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`
  on('fs.exists', async (_$: any, e: any) => ({ value: String(e.path).replace(/\\/g, '/').endsWith(dayDir) }))
  on('fs.list', async () => ({ value: ids.map((id, i) => ({ name: `rollout-x-${id}.jsonl`, kind: 'file', size: 10, mtimeMs: Date.now() - i * 60000, isLink: false })) }))
  on('fs.read', async () => ({ value: '' }))
  on('fs.stat', async () => ({ value: { kind: 'file', size: 100, mtimeMs: 0, isLink: false } }))
  const project = (i: number) => (i < 4 ? 'C:/work/strideops' : 'C:/work/landing')
  on('process.run', async (_$: any, e: any) => {
    const script = (e.argv as string[]).join(' ')
    if (script.includes('item_completed')) {
      const conv = [
        { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'fix the landing page' }] } } },
        { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['pwsh', '-Command', 'npm run build'] } } },
        { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Fixed the header and rebuilt it.' }] } } },
      ]
      return { value: { exitCode: 0, stdout: conv.map(c => JSON.stringify(c)).join('\n'), stderr: '' } }
    }
    if (script.includes('@@P')) return { value: { exitCode: 0, stdout: ids.map((id, i) => `@@P rollout-x-${id}.jsonl\t${project(i)}`).join('\n'), stderr: '' } }
    const dump = ids
      .map((id, i) => `@@FILE rollout-x-${id}.jsonl\n{"payload":{"cwd":"${project(i)}","originator":"Codex Desktop"}}\n@@TAIL\n{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"reply ${i}"}}\n`)
      .join('')
    return { value: { exitCode: 0, stdout: dump, stderr: '' } }
  })
  const ui = await $.ui.mount({ plugin: 'buddy', surface: 'terminal', component: 'Pane', requestId: 'buddy', props: {} } as any)
  await ui.press({ key: 'tab-codex' })
  if (!(await ui.find({ type: 'Text', text: /strideops/ }))) throw new Error('no strideops project header')
  if (!(await ui.find({ type: 'Text', text: /landing/ }))) throw new Error('no landing project header')
  if (!(await ui.find({ key: 'cx-more-C:/work/strideops' }))) throw new Error('no Show all for a project with 4 threads')
  const opening = ui.press({ key: `cx-open-${ids[0]}` })
  for (let i = 0; i < 50; i++) await clock.advance(50)
  await opening
  for (let i = 0; i < 10; i++) await clock.advance(50)
  if (!(await ui.find({ key: 'cx-back' }))) throw new Error('opening a thread did not open the conversation view')
  if (!(await ui.find({ type: 'Text', text: /fix the landing page/ }))) throw new Error('your message is missing from the conversation')
  if (await ui.find({ type: 'Text', text: /npm run build/ })) throw new Error('steps should be hidden until Show steps')
  await ui.press({ key: 'cx-steps' })
  if (!(await ui.find({ type: 'Text', text: /npm run build/ }))) throw new Error('Show steps did not show the command')
  if (!(await ui.find({ key: `cx-conv-msg-${ids[0]}` }))) throw new Error('no message box in the conversation')
  for (let i = 0; i < 10; i++) await clock.advance(100)
  // The kit handles a mounted pane's own scrolling, so the jump to the newest message is checked in the app.
  await ui.press({ key: 'cx-back' })
  if (!(await ui.find({ key: 'cx-refresh' }))) throw new Error('Back did not return to the project list')
  await ui.unmount()
})
