import { afterEach, expect, it } from 'vitest'
import { Journey } from '../support/journey.js'
import { McpAgent, registerAgent, replyText } from '../support/mcp-agent.js'
import { Sandbox, waitFor } from '../support/sandbox.js'
import { PTY_AVAILABLE, PTY_SKIP_REASON, Tui } from '../support/tui.js'

interface UsageRow {
  agent_id: string
  role: string | null
  department: string | null
  source: string
  model: string | null
  input_tokens: number
  output_tokens: number
  cost_usd: number
  cost_estimated: number
}

interface CommandEvent {
  command: string
  sourceAgent: string
  ok: boolean
  errorCode: string | null
}

const OWNER_ID = '424242'
const COST_USD = 2.5

/** What Claude Code exports per model request (OTLP/HTTP JSON logs). */
function apiRequestLog(): unknown {
  const kv = (key: string, value: Record<string, unknown>) => ({ key, value })
  return {
    resourceLogs: [
      {
        resource: { attributes: [kv('service.name', { stringValue: 'claude-code' })] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: `${Date.now()}000000`,
                body: { stringValue: 'claude_code.api_request' },
                attributes: [
                  kv('event.name', { stringValue: 'api_request' }),
                  kv('model', { stringValue: 'claude-sonnet-4-5' }),
                  kv('input_tokens', { intValue: '12000' }),
                  kv('output_tokens', { intValue: '3400' }),
                  kv('cache_read_tokens', { intValue: '50000' }),
                  kv('cost_usd', { doubleValue: COST_USD }),
                  kv('session.id', { stringValue: 'qa-session-1' }),
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

let sandbox: Sandbox | null = null
afterEach(async () => {
  await sandbox?.dispose()
  sandbox = null
})

it('Spend and budgets: OTLP usage, reports, a paused department', async (context) => {
  const j = new Journey(
    context.task,
    'spend-budgets',
    'Engineering gets a $1/month budget with `--pause`. While `foreman start` runs, Claude Code telemetry (OTLP JSON) reports a $2.50 request; spend shows up in `foreman usage` and `foreman org report`, agents can no longer hand Engineering work, and the inbox gets a budget alert.',
  )
  if (!PTY_AVAILABLE) return j.skip(context, PTY_SKIP_REASON)
  const sb = (sandbox = await Sandbox.create('spend'))
  const port = Number(sb.env.FOREMAN_OTLP_PORT)
  const endpoint = `http://127.0.0.1:${port}/v1/logs`
  sb.ok(['init'])
  sb.ok(['org', 'init', '--template', 'startup', '--company', 'Acme QA'])
  sb.ok(['secrets', 'add', 'telegram-chat-id'], { input: `${OWNER_ID}\n` })
  for (const id of ['hermes', 'claude-code', 'codex']) await registerAgent(sb, id)

  const delegate = async (text: string) => {
    const ceo = await McpAgent.connect(sb, 'hermes')
    const res = await ceo.call('submit_command', { command: 'write', args: ['codex', ...text.split(' ')], source_user: OWNER_ID })
    await ceo.close()
    return res
  }

  await j.step('`foreman org budget engineering 1 --pause` sets a pausing budget', (ev) => {
    expect(sb.ok(['org', 'budget', 'engineering', '1', '--pause'])).toContain("engineering: $1 per month · agents pause when it's spent")
    expect(sb.read('org.yaml')).toMatch(/budget:[\s\S]*monthly_usd: 1[\s\S]*on_exceed: pause/)
    ev('org.yaml: engineering.budget { monthly_usd: 1, on_exceed: pause }')
  })

  let tui = await Tui.start(sb)
  await tui.waitForDashboard()

  await j.step('the spend receiver listens on 127.0.0.1:$FOREMAN_OTLP_PORT and rejects requests without the key', async (ev) => {
    const key = sb.read('usage.key').trim()
    expect(key).toMatch(/^[a-f0-9]{32,}$/)
    const noKey = await waitFor('the OTLP receiver', () =>
      fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null),
    )
    expect(noKey.status).toBe(401)
    const wrongKey = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-foreman-usage-key': 'f'.repeat(key.length) },
      body: JSON.stringify(apiRequestLog()),
    })
    expect(wrongKey.status).toBe(401)
    const [rows] = sb.query<{ n: number }>('SELECT count(*) AS n FROM agent_usage')
    expect(rows?.n).toBe(0)
    ev(`FOREMAN_OTLP_PORT=${port}; POST /v1/logs without x-foreman-usage-key → ${noKey.status} ${JSON.stringify(await noKey.json())}`)
    ev(`wrong key → ${wrongKey.status}; agent_usage still empty`)
  })

  await j.step('before the spend, the CEO can hand Engineering work (the stub codex runs)', async (ev) => {
    const res = await delegate('refactor the billing module')
    expect(res.result?.isError).toBe(false)
    expect(replyText(res)).toContain('Spawning codex with your task')
    const item = await sb.inboxItem('codex finished', (i) => i.kind === 'delegation' && i.title === 'codex finished: refactor the billing module')
    ev(`hermes (ceo) → codex: "${replyText(res).slice(0, 60)}…"; inbox: "${item.title}" / "${item.body}"`)
  })

  await j.step('Claude Code telemetry with the usage key is recorded against Engineering', async (ev) => {
    const key = sb.read('usage.key').trim()
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-foreman-usage-key': key },
      body: JSON.stringify(apiRequestLog()),
    })
    expect(res.status).toBe(200)
    const row = await sb.row<UsageRow>(
      'the usage row',
      'SELECT agent_id, role, department, source, model, input_tokens, output_tokens, cost_usd, cost_estimated FROM agent_usage',
    )
    expect(row).toEqual({
      agent_id: 'claude-code',
      role: 'cto',
      department: 'engineering',
      source: 'telemetry',
      model: 'claude-sonnet-4-5',
      input_tokens: 12000,
      output_tokens: 3400,
      cost_usd: COST_USD,
      cost_estimated: 0,
    })
    ev(`POST with key → ${res.status}; agent_usage: claude-code (cto, engineering), telemetry, claude-sonnet-4-5, 12000 in / 3400 out, $${row.cost_usd} (reported, not estimated)`)
  })

  await j.step('`foreman usage` and `foreman org report engineering today` show the spend', async (ev) => {
    const usage = await sb.okAsync(['usage'])
    expect(usage).toContain('Agent spend · today · $2.50')
    expect(usage).toMatch(/engineering\s+\$2\.50/)
    const json = JSON.parse(await sb.okAsync(['usage', 'month', '--by', 'agent', '--json'])) as { rows: Array<{ key: string; costUsd: number }> }
    expect(json.rows).toEqual([expect.objectContaining({ key: 'claude-code', costUsd: COST_USD })])
    const report = await sb.okAsync(['org', 'report', 'engineering', 'today'])
    expect(report).toContain('Engineering · today')
    expect(report).toContain('Spend $2.50')
    expect(report).toMatch(/Budget engineering \(month\): \$2\.50 of \$1\.00/)
    ev(`foreman usage: "${usage.trim().split('\n').slice(0, 2).join(' | ')}"`)
    ev('foreman usage month --by agent --json: [{ key: claude-code, costUsd: 2.5 }]')
    const budgetLine = report.split('\n').find((l) => l.startsWith('Budget')) ?? ''
    ev(`foreman org report engineering today: "Engineering · today", "Spend $2.50", "${budgetLine.trim()}"`)
  })

  await j.step('with the budget spent, an agent can no longer hand Engineering work', async (ev) => {
    const res = await delegate('add caching to the billing module')
    expect(res.result?.isError).toBe(true)
    expect(replyText(res)).toContain('Paused by budget: Engineering is over its monthly budget ($2.50 of $1.00)')
    const refused = await sb.event<CommandEvent>('foreman:command', (e) => e.errorCode === 'ORG_POLICY')
    expect(refused).toMatchObject({ command: 'write', sourceAgent: 'hermes', ok: false })
    // The first directive, and Foreman handing codex's result back to
    // hermes (delegation-loop.ts); nothing new from hermes.
    const writes = sb.query<{ source_agent: string; agent: string }>(
      "SELECT source_agent, json_extract(args, '$[0]') AS agent FROM control_commands WHERE command = 'write' ORDER BY id",
    )
    expect(writes).toEqual([
      { source_agent: 'hermes', agent: 'codex' },
      { source_agent: 'foreman:delegation', agent: 'hermes' },
    ])
    ev(`hermes → codex: "${replyText(res).slice(0, 120)}…"`)
    ev('audit_events foreman:command: write from hermes ok=false errorCode=ORG_POLICY; control_commands holds only the first directive (and Foreman handing its result back to hermes)')
  })

  await j.step('the owner can still assign work to the paused department from the TUI', async (ev) => {
    const mark = tui.mark()
    await tui.command('write codex ship the hotfix')
    await tui.waitForText('Spawning codex with your task', { from: mark })
    const item = await sb.inboxItem('codex finished the hotfix', (i) => i.title === 'codex finished: ship the hotfix')
    ev(`TUI console "write codex ship the hotfix" → spawned; inbox: "${item.title}"`)
  })

  await j.step('the budget alert lands in the inbox (the watcher checks at start, then every minute)', async (ev) => {
    expect(await tui.stop()).toBe(0)
    tui = await Tui.start(sb)
    const alert = await sb.inboxItem('the budget alert', (i) => i.kind === 'budget')
    expect(alert.level).toBe('critical')
    expect(alert.title).toBe('Engineering is over its monthly budget')
    expect(alert.body).toContain("$2.50 of $1.00")
    expect(alert.body).toContain("agents can't hand it new work until the period resets")
    ev(`restarted foreman start; inbox: [${alert.level}] "${alert.title}" / "${alert.body}"`)
    expect(await tui.stop()).toBe(0)
  })

  await j.step('nothing tried to reach the network', (ev) => {
    expect(sb.networkAttempts()).toEqual([])
    ev('network guard: 0 non-loopback connection attempts')
  })
})
