import type { Register } from 'claude-code'

// The MCP server name `lcu setup` registers.
const SERVER = 'lcu'
const REQUEST_TOOL = 'approval_request'
const CHOICE_TOOL = 'approval_choice'
const ASK_HEADER = 'Computer use'
const LABEL_SESSION = 'Allow this conversation'
const LABEL_ALWAYS = 'Always allow'
const LABEL_DENY = 'Deny'
const WARNING_TITLE = 'Elevated risk'

type Choice = 'session' | 'always' | 'deny' | 'cancel'

type Approval = {
  id: string
  message: string
  app: string
  label: string
  scopes: string[]
  riskLevel: string
  warning?: string
}

// Panes on screen, by pane id.
const shown = new Map<string, Approval>()

type McpResult = { isError?: boolean; content?: { type: string; text?: string }[] }

const textOf = (result: McpResult) =>
  (result.content ?? []).map(item => item.text ?? '').join('')

const paneId = (approval: Approval) => `lcu-approval-${approval.id}`

export const register: Register = on => {
  on('classic.Elicitation', async ($, e, next) => {
    if (e.mcp_server_name !== SERVER) return next(e)
    // Nobody to ask in a headless run: the engine answers for itself.
    if ((await $.session.surfaces()).length === 0) return next(e)

    let approval: Approval
    try {
      const reply = (await $.mcp.call(SERVER, REQUEST_TOOL, { message: e.message })) as McpResult
      // Not a native-app approval (or LCU has no such pending request): leave the engine's form.
      if (reply.isError) return next(e)
      approval = JSON.parse(textOf(reply)) as Approval
    } catch {
      return next(e)
    }

    // No hook stays pending while the person decides: a pending hook keeps the desktop surface from
    // delivering the pane's presses. The pane's button (or Esc) records the choice with LCU, whose
    // relay keeps the runtime's elicitation open until then; this hook only blocks the engine's form.
    if (!(await showPane($, approval))) {
      // A narrow terminal seats no pane: ask from a timer, which is a dispatch of its own.
      $.clock.after(0, () => askAndRecord($, approval))
    }
    return { block: 'Answered by the lcu-approve mod' }
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    const approval = shown.get(e.requestId)
    if (!approval) return next(e)
    const settle = (choice: Choice) => void finish($, approval, choice)
    const { Box, Text, Button } = $.ui.resolve(e)
    const isHigh = approval.riskLevel === 'high'
    return (
      <Box flexDirection="column">
        {isHigh && <Text bold color="yellow">{WARNING_TITLE}</Text>}
        <Text bold>{approval.message}</Text>
        <Text dimColor>
          {approval.label === approval.app ? approval.app : `${approval.label} (${approval.app})`}
        </Text>
        {approval.warning && <Text color={isHigh ? 'yellow' : undefined}>{approval.warning}</Text>}
        <Box flexDirection="row">
          <Button key="session" variant="primary" hotkey="1" onPress={() => settle('session')}>
            {LABEL_SESSION}
          </Button>
          {approval.scopes.includes('always') && (
            <Button key="always" hotkey="2" onPress={() => settle('always')}>
              {LABEL_ALWAYS}
            </Button>
          )}
          <Button key="deny" hotkey="3" onPress={() => settle('deny')}>
            {LABEL_DENY}
          </Button>
        </Box>
      </Box>
    )
  })

  // Esc or the close mark dismisses the pane: that is a cancel.
  on('ui.close', async ($, e, next) => {
    const approval = shown.get(e.id)
    if (approval && e.origin.kind === 'person') {
      shown.delete(e.id)
      await record($, approval.id, 'cancel')
    }
    return next(e)
  })

  // The approval tools are for this mod alone: the model gets a refusal,
  // and the mod's own calls need no permission card.
  for (const name of [REQUEST_TOOL, CHOICE_TOOL]) {
    const tool = `mcp__${SERVER}__${name}`
    on('tool.call', { tool }, async ($, e, next) => {
      if (next.origin.plugin !== $.plugin.name) {
        return { deny: `${name} is a host-only LCU tool.` }
      }
      return next(e)
    })
    on('tool.check', { tool }, async ($, e, next) => {
      if (next.origin.plugin !== $.plugin.name) return next(e)
      return { decision: 'allow', reason: 'LCU approval mod' }
    })
  }
}

// Tell LCU what the person chose; false when LCU refused it.
async function record($: any, id: string, choice: Choice): Promise<boolean> {
  try {
    const reply = (await $.mcp.call(SERVER, CHOICE_TOOL, { id, choice })) as McpResult
    return !reply.isError
  } catch {
    return false
  }
}

// Record the person's choice, then take the pane down. A refused record means the request ended.
async function finish($: any, approval: Approval, choice: Choice): Promise<void> {
  await record($, approval.id, choice)
  const id = paneId(approval)
  shown.delete(id)
  await $.ui.close({ id }).catch(() => {})
}

// Open the pane; false when it waits undrawn (a narrow terminal) and the person needs another prompt.
async function showPane($: any, approval: Approval): Promise<boolean> {
  const id = paneId(approval)
  shown.set(id, approval)
  try {
    const opened = await $.ui.open({
      id,
      title: 'Computer use approval',
      focus: true,
      closeOnEscape: true,
      holdToasts: true,
      rows: 9,
    })
    if (opened.isPlaced) return true
  } catch {
    // Fall through to the question dialog.
  }
  shown.delete(id)
  await $.ui.close({ id }).catch(() => {})
  return false
}

// The engine's question dialog, for where no pane is seated.
async function askAndRecord($: any, approval: Approval): Promise<void> {
  const options = [LABEL_SESSION, ...(approval.scopes.includes('always') ? [LABEL_ALWAYS] : []), LABEL_DENY]
  const risk = approval.riskLevel === 'high' && approval.warning ? `\n${WARNING_TITLE}: ${approval.warning}` : ''
  const started = Date.now()
  let choice: Choice = 'cancel'
  try {
    const answer: string = await $.ui.ask(`${approval.message}${risk}`, { options, header: ASK_HEADER })
    choice = 'deny'
    // A person cannot answer in under a few hundred milliseconds; anything faster was not a person.
    if (Date.now() - started >= 400) {
      if (answer === LABEL_SESSION) choice = 'session'
      else if (answer === LABEL_ALWAYS && options.includes(LABEL_ALWAYS)) choice = 'always'
    }
  } catch {
    // Dismissed.
  }
  await record($, approval.id, choice)
}
