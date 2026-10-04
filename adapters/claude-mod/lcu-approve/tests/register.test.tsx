import { expect, mock, test } from 'claude-code/testing'

const APPROVAL = {
  id: 'abc',
  message: 'Allow Computer Use to use "Zed"?',
  app: 'dev.zed.Zed',
  label: 'Zed',
  scopes: ['session', 'always'],
  riskLevel: 'high',
  warning: 'Allowing ChatGPT to use this app introduces new risks.',
}

const ok = (value: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(value) }] } })

// Stand in for LCU beneath the mod: record what the mod sends, answer like the relay.
function lcu(on: any, { approval = APPROVAL, surfaces = ['terminal'], placed = true } = {}) {
  const calls: { tool: string; args: any }[] = []
  on('session.surfaces', () => ({ value: surfaces }))
  on('classic.Elicitation', () => ({}))
  on('ui.close', () => ({}))
  on('ui.open', () => ({ value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }))
  // `$.mcp.call(server, tool, args)` reaches the bottom as one `mcp.call` event.
  on('mcp.call', async (_$: any, e: any) => {
    expect(e.server).toBe('lcu')
    if (e.tool === 'approval_request') {
      calls.push({ tool: 'request', args: e.args })
      return ok(approval)
    }
    calls.push({ tool: 'choice', args: e.args })
    return ok({ ok: true })
  })
  return calls
}

// Let the mod's hook run until LCU has seen the call.
async function until(clock: any, seen: () => boolean) {
  for (let tick = 0; tick < 400 && !seen(); tick++) await clock.advance(5)
}

const ELICITATION = { mcp_server_name: 'lcu', message: APPROVAL.message }

async function openPane($: any, clock: any, calls: any[]) {
  const result: any = await $.classic.Elicitation(ELICITATION as any)
  await until(clock, () => calls.some(call => call.tool === 'request'))
  const ui = await $.ui.mount({
    plugin: 'lcu-approve',
    surface: 'terminal',
    component: 'Pane',
    requestId: `lcu-approval-${APPROVAL.id}`,
    props: { title: 'Computer use approval', isFocused: true, bodyColumns: 100, placement: 'inline' } as any,
  })
  return { result, ui }
}

test('the hook blocks at once; a pane press then records the choice with LCU', async ($, on) => {
  const clock = mock.clock(on)
  const calls = lcu(on)
  // The hook returns without a press: nothing waits on the person.
  const { result, ui } = await openPane($, clock, calls)
  expect(result.block).toBeDefined()
  expect(calls.map(call => call.tool)).toEqual(['request'])
  expect((await ui.findAll({ type: 'Button' })).map(button => button.text)).toEqual([
    'Allow this conversation', 'Always allow', 'Deny',
  ])
  expect(await ui.find({ type: 'Text', text: /new risks/ })).toBeDefined()
  await ui.press({ key: 'always' })
  expect(calls.filter(call => call.tool === 'choice').map(call => call.args.choice)).toEqual(['always'])
  expect(calls.find(call => call.tool === 'choice')?.args.id).toBe(APPROVAL.id)
})

test('the pane leaves out Always allow when the runtime did not offer it', async ($, on) => {
  const clock = mock.clock(on)
  const calls = lcu(on, { approval: { ...APPROVAL, scopes: ['session'], riskLevel: 'low', warning: undefined as any } })
  const { ui } = await openPane($, clock, calls)
  expect((await ui.findAll({ type: 'Button' })).map(button => button.text)).toEqual(['Allow this conversation', 'Deny'])
  await ui.press({ key: 'deny' })
  expect(calls.filter(call => call.tool === 'choice').map(call => call.args.choice)).toEqual(['deny'])
})

test('a pane on a narrow terminal is replaced by the question dialog, asked after the hook returned', async ($, on) => {
  const clock = mock.clock(on)
  const calls = lcu(on, { placed: false })
  const questions: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$: any, e: any) => {
    questions.push(JSON.stringify(e))
    await clock.advance(1000)
    return { value: { content: 'Deny' } } as any
  })
  const result: any = await $.classic.Elicitation(ELICITATION as any)
  expect(result.block).toBeDefined()
  expect(calls.map(call => call.tool)).toEqual(['request'])
  await until(clock, () => calls.some(call => call.tool === 'choice'))
  expect(questions.length).toBe(1)
  expect(calls.filter(call => call.tool === 'choice').length).toBe(1)
})

test('an elicitation LCU does not recognize is left to the engine', async ($, on) => {
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('classic.Elicitation', () => ({}))
  on('mcp.call', () => ({ value: { isError: true, content: [{ type: 'text', text: 'none' }] } }))
  const result: any = await $.classic.Elicitation(ELICITATION as any)
  expect(result.block).toBeUndefined()
})

test('another server, and a headless run, are left to the engine', async ($, on) => {
  const calls = lcu(on, { surfaces: [] })
  const headless: any = await $.classic.Elicitation(ELICITATION as any)
  expect(headless.block).toBeUndefined()
  const other: any = await $.classic.Elicitation({ mcp_server_name: 'other', message: 'Hi?' } as any)
  expect(other.block).toBeUndefined()
  expect(calls).toEqual([])
})

test('the model may not call the host-only tools', async ($, on) => {
  for (const name of ['approval_request', 'approval_choice']) {
    const denied: any = await $.tool.call({ tool: `mcp__lcu__${name}`, tool_use_id: 'toolu_01abc' } as any)
    expect(JSON.stringify(denied)).toContain('host-only')
  }
})
