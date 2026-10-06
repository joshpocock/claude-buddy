import { expect, mock, test } from 'claude-code/testing'

const setup = (on: any, entries: Record<string, unknown> = {}) => {
  mock.clock(on)
  mock.store(on, entries)
  mock.env(on, { USERPROFILE: 'C:/buddy-test' })
  on('fs.exists', async () => ({ value: false }))
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
  setup(on, { todos: [{ id: 't1', task: 'Add your OpenAI key to .env', sessionId: 'other', chat: 'demo', at: 1 }] })
  const ui = await $.ui.mount({ plugin: 'buddy', surface: 'terminal', component: 'Pane', requestId: 'buddy', props: {} } as any)
  expect(await ui.find({ key: 'todo-done-t1' })).toBeDefined()
  await ui.press({ key: 'todo-skip-t1' })
  expect(await ui.find({ key: 'todo-done-t1' })).toBeUndefined()
  await ui.unmount()
})
