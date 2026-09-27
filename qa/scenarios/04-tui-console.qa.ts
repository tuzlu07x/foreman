import { afterEach, expect, it } from 'vitest'
import { Journey } from '../support/journey.js'
import { McpAgent, registerAgent, replyText } from '../support/mcp-agent.js'
import { Sandbox } from '../support/sandbox.js'
import { KEY, PTY_AVAILABLE, PTY_SKIP_REASON, Tui } from '../support/tui.js'

interface ControlRow {
  id: number
  command: string
  args: string
  source_agent: string | null
  status: string
}

interface CommandEvent {
  command: string
  args: string[]
  sourceAgent: string
  ok: boolean
  errorCode: string | null
}

interface WriteOutcome {
  id: number
  agentId: string
  command: string | null
  spawnKind: string
  exitCode: number | null
  stdoutTail: string | null
}

let sandbox: Sandbox | null = null
afterEach(async () => {
  await sandbox?.dispose()
  sandbox = null
})

it('TUI command console: status, write, approve', async (context) => {
  const j = new Journey(
    context.task,
    'tui-console',
    'The `:` console in `foreman start` (real pty): `status`, `write codex add tests` (the stub codex runs and its output lands in the inbox), and `approve` for an approval on screen.',
  )
  if (!PTY_AVAILABLE) return j.skip(context, PTY_SKIP_REASON)
  const sb = (sandbox = await Sandbox.create('tui-console'))
  sb.ok(['init'])
  await registerAgent(sb, 'codex')
  await registerAgent(sb, 'claude-code')

  const tui = await Tui.start(sb)
  await tui.waitForDashboard()

  await j.step('`:` then `status` lists the registered agents', async (ev) => {
    const mark = tui.mark()
    await tui.command('status')
    const screen = await tui.waitForText(/2 agents registered[\s\S]*codex/, { from: mark })
    expect(screen).toContain('claude-code')
    const event = await sb.event<CommandEvent>('foreman:command', (e) => e.command === 'status')
    expect(event).toMatchObject({ sourceAgent: 'tui', ok: true })
    ev('console: "Foreman v… — 2 agents registered", lists codex and claude-code')
    ev('audit_events foreman:command: status, sourceAgent=tui, ok=true')
  })

  await j.step('`write codex add tests` runs the (stub) codex and its output lands in `foreman inbox`', async (ev) => {
    const mark = tui.mark()
    await tui.command('write codex add tests', { alreadyOpen: true })
    await tui.waitForText('Spawning codex with your task', { from: mark })
    ev('console: "Spawning codex with your task — output will arrive in the Activity feed and your inbox…"')
    const item = await sb.inboxItem('codex finished', (i) => i.kind === 'delegation' && i.agentId === 'codex')
    expect(item.title).toBe('codex finished: add tests')
    expect(item.body).toContain('[qa-stub codex] received: exec add tests')
    ev(`foreman inbox --json: "${item.title}" / "${item.body}"`)
    const control = await sb.row<ControlRow>(
      'the applied write directive',
      "SELECT id, command, args, source_agent, status FROM control_commands WHERE command = 'write' AND status = 'applied'",
    )
    expect(JSON.parse(control.args)).toEqual(['codex', 'add tests'])
    expect(control.source_agent).toBe('tui')
    const outcome = await sb.event<WriteOutcome>('control_write_outcome', (e) => e.id === control.id)
    expect(outcome).toMatchObject({ agentId: 'codex', spawnKind: 'ok', exitCode: 0, command: 'codex exec "{task}"' })
    expect(outcome.stdoutTail).toContain('[qa-stub codex]')
    const command = await sb.event<CommandEvent>('foreman:command', (e) => e.command === 'write')
    expect(command).toMatchObject({ sourceAgent: 'tui', ok: true, args: ['codex', 'add', 'tests'] })
    ev(`control_commands #${control.id}: write ["codex","add tests"] from tui → applied`)
    ev(`audit_events control_write_outcome: codex exec → spawnKind=ok exitCode=0; foreman:command write ok`)
  })

  await j.step('`approve` in the console decides the approval on screen', async (ev) => {
    const closing = tui.mark()
    tui.press(KEY.escape)
    await tui.waitForText('? help', { from: closing })
    const agent = await McpAgent.connect(sb, 'claude-code', { FOREMAN_APPROVAL_TIMEOUT: '90' })
    const mark = tui.mark()
    const reply = agent.call('read_file', { path: 'service/.env.production' }, 120_000)
    await tui.waitForText('service/.env.production', { from: mark })
    const pending = await sb.row<{ request_id: string }>(
      'the pending approval',
      "SELECT request_id FROM pending_approvals WHERE status = 'pending' AND args LIKE '%.env.production%'",
    )
    ev(`approval on screen: claude-code → read_file(service/.env.production), request ${pending.request_id}`)
    const beforeApprove = tui.mark()
    await tui.command('approve')
    await tui.waitForText('Allowed read_file for claude-code.', { from: beforeApprove })
    const res = await reply
    expect(replyText(res)).toBe('(foreman) read_file allowed by user:tui')
    const row = await sb.row<{ decision: string; decided_by: string }>(
      'the requests row',
      'SELECT decision, decided_by FROM requests WHERE id = ?',
      pending.request_id,
    )
    expect(row.decision).toBe('allowed')
    expect(row.decided_by).toMatch(/^user(:tui)?$/)
    const item = await sb.inboxItem('the approval outcome', (i) => i.requestId === pending.request_id && i.title.startsWith('Allowed'))
    expect(item.body).toBe('by you in the TUI')
    ev('console: "Allowed read_file for claude-code."')
    ev(`agent reply: "${replyText(res)}"; requests: allowed, decided_by=${row.decided_by}; inbox: "${item.title}" / "${item.body}"`)
    expect(await agent.close()).toBe(0)
  })

  await j.step('`foreman start` shuts down cleanly and nothing reached the network', async (ev) => {
    expect(await tui.stop()).toBe(0)
    expect(sb.networkAttempts()).toEqual([])
    ev('foreman start exited 0; network guard: 0 non-loopback connection attempts')
  })
})
