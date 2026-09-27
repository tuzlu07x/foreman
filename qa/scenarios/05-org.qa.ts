import { readFileSync, writeFileSync } from 'node:fs'
import { parseDocument } from 'yaml'
import { afterEach, expect, it } from 'vitest'
import { Journey } from '../support/journey.js'
import { McpAgent, registerAgent, replyText } from '../support/mcp-agent.js'
import { DEMO_SERVER, Sandbox } from '../support/sandbox.js'

interface CommandEvent {
  command: string
  args: string[]
  sourceAgent: string
  ok: boolean
  errorCode: string | null
}

interface OrgMessageEvent {
  sourceAgent: string
  tool: string
  ok: boolean
  channel: string | null
  reason: string | null
}

/** Stands in for the owner's Telegram user id, which `submit_command
 *  write` checks (it is never sent anywhere: no bot token is configured). */
const OWNER_ID = '424242'

let sandbox: Sandbox | null = null
afterEach(async () => {
  await sandbox?.dispose()
  sandbox = null
})

it('Org: chart, delegation, department channels and per-department MCP servers', async ({ task }) => {
  const j = new Journey(
    task,
    'org',
    'A startup org chart run by agents: grow it from the CLI, then check that delegation (`submit_command write`), department channels (`org_post`) and the MCP hub all follow the chart.',
  )
  const sb = (sandbox = await Sandbox.create('org'))
  sb.ok(['init'])
  sb.ok(['secrets', 'add', 'telegram-chat-id'], { input: `${OWNER_ID}\n` })

  await j.step('`foreman org init --template startup` writes a valid chart', (ev) => {
    const out = sb.ok(['org', 'init', '--template', 'startup', '--company', 'Acme QA'])
    expect(sb.run(['org', 'validate']).status).toBe(0)
    const show = sb.ok(['org', 'show'])
    for (const role of ['ceo', 'cto', 'engineer', 'cmo', 'cfo']) expect(show).toContain(role)
    ev(`org init: "${out.trim().split('\n')[0]}"; org validate exits 0`)
    ev('org show: ceo (hermes), cto (claude-code), engineer (codex), cmo (openclaw), cfo (zeroclaw), support-lead')
  })

  await j.step('grow it: `org add-department sales`, `org add-role sdr` and `org add-role qa`', (ev) => {
    expect(sb.ok(['org', 'add-department', 'sales', '--head', 'cso', '--agent', 'sales-agent', '--name', 'Sales'])).toContain(
      'added sales, led by cso',
    )
    expect(sb.ok(['org', 'add-role', 'sdr', '--agent', 'sdr-agent', '--department', 'sales', '--title', 'Sales rep'])).toContain(
      'reporting to cso',
    )
    expect(sb.ok(['org', 'add-role', 'qa', '--agent', 'qa-agent', '--department', 'engineering', '--title', 'QA engineer'])).toContain(
      'reporting to cto',
    )
    expect(sb.run(['org', 'validate']).status).toBe(0)
    const yaml = sb.read('org.yaml')
    expect(yaml).toContain('# Foreman Org')
    ev('sales (head cso = sales-agent), sdr → cso, qa → cto; org validate exits 0; org.yaml comments kept')
  })

  await j.step('`foreman org check` explains delegation decisions', (ev) => {
    const ok = sb.run(['org', 'check', 'claude-code', 'codex'])
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain('allowed — cto manages engineer')
    const blocked = sb.run(['org', 'check', 'codex', 'openclaw'])
    expect(blocked.status).toBe(1)
    expect(blocked.stdout).toContain('blocked')
    ev(`claude-code → codex: "${ok.stdout.trim()}"`)
    ev(`codex → openclaw: "${blocked.stdout.trim()}" (exit 1)`)
  })

  // Every agent connects once, which registers it (write targets must exist).
  for (const id of ['codex', 'openclaw', 'qa-agent', 'claude-code', 'sdr-agent', 'sales-agent']) await registerAgent(sb, id)

  const write = async (from: string, to: string, text: string) => {
    const agent = await McpAgent.connect(sb, from)
    const res = await agent.call('submit_command', { command: 'write', args: [to, ...text.split(' ')], source_user: OWNER_ID })
    await agent.close()
    return res
  }

  await j.step('delegation along the chart is queued; across departments it is blocked (ORG_POLICY)', async (ev) => {
    const down = await write('claude-code', 'codex', 'write unit tests for the parser')
    expect(down.result?.isError).toBe(false)
    expect(replyText(down)).toContain('Spawning codex with your task')
    const queued = await sb.row<{ id: number; args: string; source_agent: string; status: string }>(
      'the queued directive',
      "SELECT id, args, source_agent, status FROM control_commands WHERE command = 'write' AND source_agent = 'claude-code'",
    )
    expect(JSON.parse(queued.args)).toEqual(['codex', 'write unit tests for the parser'])
    ev(`cto (claude-code) → engineer (codex): "${replyText(down).slice(0, 60)}…"; control_commands #${queued.id} ${queued.status}`)

    const heads = await write('sales-agent', 'claude-code', 'need a demo environment')
    expect(heads.result?.isError).toBe(false)
    ev('cso (sales-agent, the new Sales head) → cto (claude-code): queued (heads coordinate directly)')

    const across = await write('codex', 'openclaw', 'post the release notes')
    expect(across.result?.isError).toBe(true)
    expect(replyText(across)).toContain('Blocked by the org chart')
    expect(replyText(across)).toContain('cross-department work goes through department heads')
    const sdr = await write('sdr-agent', 'qa-agent', 'test the pricing page')
    expect(sdr.result?.isError).toBe(true)
    expect(replyText(sdr)).toContain('Blocked by the org chart')
    ev(`engineer (codex) → cmo (openclaw): "${replyText(across).slice(0, 150)}…"`)
    ev('sdr (sdr-agent) → qa (qa-agent): blocked by the org chart')

    const refused = sb.events<CommandEvent>('foreman:command').filter((e) => e.errorCode === 'ORG_POLICY')
    expect(refused.map((e) => e.sourceAgent).sort()).toEqual(['codex', 'sdr-agent'])
    const rows = sb.query<{ source_agent: string }>("SELECT source_agent FROM control_commands WHERE command = 'write' ORDER BY id")
    expect(rows.map((r) => r.source_agent)).toEqual(['claude-code', 'sales-agent'])
    ev('audit_events foreman:command: 2 × ok=false errorCode=ORG_POLICY (codex, sdr-agent); control_commands holds only the 2 allowed directives')
  })

  await j.step('`org_post` follows the chart; `foreman org messages` shows what was said', async (ev) => {
    const post = async (from: string, to: string, text: string, tool = 'org_post') => {
      const agent = await McpAgent.connect(sb, from)
      const res = await agent.call(tool, tool === 'org_report' ? { text } : { to, text })
      await agent.close()
      return res
    }
    const own = await post('codex', 'engineering', 'parser tests are green')
    expect(replyText(own)).toMatch(/^Posted to #engineering/)
    const cross = await post('codex', 'marketing', 'can you tweet about the parser?')
    expect(cross.result?.isError).toBe(true)
    expect(replyText(cross)).toBe('Not sent: write to your department head, who can take it to marketing.')
    const head = await post('claude-code', 'marketing', 'parser ships Friday')
    expect(replyText(head)).toMatch(/^Posted to #marketing/)
    const lead = await post('sdr-agent', 'leadership', 'pipeline doubled')
    expect(lead.result?.isError).toBe(true)
    expect(replyText(lead)).toContain('only department heads and the roles that report to you post in leadership')
    const report = await post('codex', '', 'finished the parser tests', 'org_report')
    expect(replyText(report)).toMatch(/^Posted to (cto ↔ engineer|engineer ↔ cto)/)
    ev(`codex → #engineering: "${replyText(own)}"`)
    ev(`codex → #marketing: "${replyText(cross)}"`)
    ev(`claude-code (head) → #marketing: posted; sdr-agent → #leadership: refused; codex org_report → "${replyText(report)}"`)

    const all = sb.ok(['org', 'messages'])
    for (const text of ['parser tests are green', 'parser ships Friday', 'finished the parser tests']) expect(all).toContain(text)
    expect(all).not.toContain('can you tweet about the parser?')
    expect(all).not.toContain('pipeline doubled')
    const engineering = sb.ok(['org', 'messages', 'engineering'])
    expect(engineering).toContain('parser tests are green')
    expect(engineering).not.toContain('parser ships Friday')
    ev(`foreman org messages: 3 messages, e.g. "${all.trim().split('\n')[0]}"`)
    ev('foreman org messages engineering: only the #engineering message')

    const events = sb.events<OrgMessageEvent>('org:message')
    expect(events.filter((e) => e.ok)).toHaveLength(3)
    expect(events.filter((e) => !e.ok).map((e) => e.sourceAgent).sort()).toEqual(['codex', 'sdr-agent'])
    const stored = sb.query<{ channel: string }>('SELECT channel FROM org_messages ORDER BY ts, id')
    expect(stored.map((m) => m.channel)).toEqual(['dept:engineering', 'dept:marketing', 'dm:cto|engineer'])
    ev('audit_events org:message: 3 ok, 2 refused (codex, sdr-agent); org_messages channels: dept:engineering, dept:marketing, dm:cto|engineer')
  })

  await j.step('each department sees only its own MCP hub servers', async (ev) => {
    const server = [`    command: ${JSON.stringify(process.execPath)}`, `    args: [${JSON.stringify(DEMO_SERVER)}]`]
    sb.write('mcp.yaml', ['servers:', '  demo:', ...server, '  brand-kit:', ...server, ''].join('\n'))
    const orgPath = sb.path('org.yaml')
    const doc = parseDocument(readFileSync(orgPath, 'utf-8'))
    doc.setIn(['departments', 'engineering', 'mcp_servers'], ['demo'])
    doc.setIn(['departments', 'marketing', 'mcp_servers'], ['brand-kit'])
    writeFileSync(orgPath, doc.toString())
    expect(sb.run(['org', 'validate']).status).toBe(0)
    const show = sb.ok(['org', 'show'])
    expect(show).toMatch(/mcp: demo/)
    expect(show).toMatch(/mcp: brand-kit/)
    ev('mcp.yaml: servers demo and brand-kit; org.yaml: engineering → [demo], marketing → [brand-kit]')

    const hubTools = async (id: string) => {
      const agent = await McpAgent.connect(sb, id)
      const names = (await agent.toolNames()).filter((n) => n.includes('__'))
      return { agent, names }
    }
    const eng = await hubTools('codex')
    expect(eng.names).toContain('demo__echo')
    expect(eng.names.some((n) => n.startsWith('brand-kit__'))).toBe(false)
    const denied = await eng.agent.call('brand-kit__echo', { text: 'hi' })
    expect(denied.result?.isError).toBe(true)
    expect(replyText(denied)).toContain("Your role in org.yaml does not include the 'brand-kit' MCP server")
    await eng.agent.close()
    const mkt = await hubTools('openclaw')
    expect(mkt.names).toContain('brand-kit__echo')
    expect(mkt.names.some((n) => n.startsWith('demo__'))).toBe(false)
    await mkt.agent.close()
    ev(`codex (engineering) sees: ${eng.names.join(', ')}`)
    ev(`openclaw (marketing) sees: ${mkt.names.join(', ')}`)
    ev(`codex calling brand-kit__echo: "${replyText(denied)}"`)
  })

  await j.step('nothing tried to reach the network', (ev) => {
    expect(sb.networkAttempts()).toEqual([])
    ev('network guard: 0 non-loopback connection attempts')
  })
})
