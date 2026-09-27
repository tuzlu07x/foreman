import { afterEach, expect, it } from 'vitest'
import { Journey } from '../support/journey.js'
import { McpAgent, replyText } from '../support/mcp-agent.js'
import { DEMO_SERVER, Sandbox } from '../support/sandbox.js'

interface RequestRow {
  id: string
  target_tool: string
  decision: string
  decided_by: string
  risk_bucket: string | null
}

interface McpCallEvent {
  requestId: string
  sourceAgent: string
  server: string
  tool: string
  isError: boolean
  error?: string
  redactions?: number
  injectionFlags?: string[]
}

interface HubTools {
  servers: Array<{ name: string; source: string; tools: number; quarantined: number }>
  tools: Array<{ server: string; name: string; status: string; reasons: string[]; findings: Array<{ severity: string }> }>
}

/** mcp.yaml: `demo` (variant switchable, echo + read_config allowed,
 *  delete_* denied) and `sketchy`, a server with a poisoned tool. */
function mcpYaml(demoVariant: 'clean' | 'changed'): string {
  const server = (variant: string): string[] => [
    `    command: ${JSON.stringify(process.execPath)}`,
    `    args: [${JSON.stringify(DEMO_SERVER)}]`,
    `    env: { DEMO_VARIANT: ${variant} }`,
  ]
  return [
    'servers:',
    '  demo:',
    ...server(demoVariant),
    '    tools:',
    '      allow: [echo, read_config]',
    '      deny: ["delete_*"]',
    '  sketchy:',
    ...server('poisoned'),
    '',
  ].join('\n')
}

let sandbox: Sandbox | null = null
afterEach(async () => {
  await sandbox?.dispose()
  sandbox = null
})

it('MCP agent through mcp-stdio and the hub: allow, ask/timeout, poisoning, rug pull', async ({ task }) => {
  const j = new Journey(
    task,
    'mcp-hub',
    'An MCP agent (`claude-code`) talks to `foreman mcp-stdio`, which proxies two upstream MCP servers from mcp.yaml (the real demo server from tests/core/mcp-hub/fixtures). Every decision is checked in the audit DB.',
  )
  const sb = (sandbox = await Sandbox.create('mcp-hub'))
  sb.ok(['init'])
  sb.write('mcp.yaml', mcpYaml('clean'))
  const requestColumns = 'SELECT id, target_tool, decision, decided_by, risk_bucket FROM requests'
  const lastRequest = (tool: string): Promise<RequestRow> =>
    sb.row<RequestRow>(`the requests row for ${tool}`, `${requestColumns} WHERE target_tool = ? ORDER BY rowid DESC LIMIT 1`, tool)
  const mcpCall = (requestId: string): Promise<McpCallEvent> =>
    sb.event<McpCallEvent>('mcp:call', (e) => e.requestId === requestId)

  const agent = await McpAgent.connect(sb, 'claude-code', { FOREMAN_APPROVAL_TIMEOUT: '2' })

  await j.step('tools/list has Foreman tools plus the hub tools, minus denied and poisoned ones', async (ev) => {
    const names = await agent.toolNames()
    expect(names).toEqual(expect.arrayContaining(['secrets/get', 'submit_command', 'org_post', 'demo__echo', 'demo__read_config']))
    expect(names).not.toContain('demo__delete_everything')
    expect(names).not.toContain('sketchy__add')
    expect(names).toContain('sketchy__echo')
    ev(`${names.length} tools; hub: ${names.filter((n) => n.includes('__')).join(', ')}`)
    ev('hidden: demo__delete_everything (tools.deny), sketchy__add (poisoned description)')
  })

  await j.step('an allowed hub call returns upstream data and is audited as allowed', async (ev) => {
    const res = await agent.call('demo__echo', { text: 'hello from qa' })
    expect(replyText(res)).toBe('hello from qa')
    const row = await lastRequest('demo__echo')
    expect(row).toMatchObject({ decision: 'allowed', decided_by: 'policy:mcp.yaml:demo' })
    const call = await mcpCall(row.id)
    expect(call).toMatchObject({ server: 'demo', tool: 'echo', isError: false, sourceAgent: 'claude-code' })
    ev(`reply: "${replyText(res)}"`)
    ev(`requests ${row.id}: demo__echo allowed, decided_by=${row.decided_by}`)
    ev(`audit_events mcp:call: server=demo tool=echo isError=false`)
  })

  await j.step('results are guarded: secrets redacted and injected instructions flagged', async (ev) => {
    const res = await agent.call('demo__read_config', {})
    const text = replyText(res)
    expect(text).not.toMatch(/ghp_a{36}/)
    expect(text).toContain('endpoint=https://api.demo.example')
    const row = await lastRequest('demo__read_config')
    expect(row.decision).toBe('allowed')
    const call = await mcpCall(row.id)
    expect(call?.redactions ?? 0).toBeGreaterThan(0)
    expect(call?.injectionFlags?.length ?? 0).toBeGreaterThan(0)
    ev(`token in the upstream result is not in the reply; mcp:call redactions=${call?.redactions}, injectionFlags=${JSON.stringify(call?.injectionFlags)}`)
    ev(`reply starts: "${text.slice(0, 90)}"`)
  })

  await j.step('a hub tool with no rule asks; nobody answers, so it is denied on timeout and audited', async (ev) => {
    const res = await agent.call('demo__big_report', {})
    expect(res.error?.message).toBe('Denied by approval-timeout')
    const row = await lastRequest('demo__big_report')
    expect(row).toMatchObject({ decision: 'denied', decided_by: 'approval-timeout' })
    const pending = await sb.row<{ status: string; decision: string; resolved_by: string }>(
      'the pending approval',
      'SELECT status, decision, resolved_by FROM pending_approvals WHERE request_id = ?',
      row.id,
    )
    expect(pending).toEqual({ status: 'resolved', decision: 'denied', resolved_by: 'timeout' })
    ev(`reply: ${replyText(res)} (FOREMAN_APPROVAL_TIMEOUT=2)`)
    ev(`requests ${row.id}: denied, decided_by=approval-timeout; pending_approvals: resolved/denied by timeout`)
  })

  await j.step('the poisoned tool is quarantined: hidden from the listing and refused when called', async (ev) => {
    const res = await agent.call('sketchy__add', { a: 1, b: 2 })
    expect(res.result?.isError).toBe(true)
    expect(replyText(res)).toContain("Foreman withheld 'sketchy__add': suspicious definition")
    const inventory = sb.json<HubTools>(['mcp', 'tools', 'sketchy', '--json'])
    const add = inventory.tools.find((t) => t.name === 'add')
    expect(add?.status).toBe('quarantined')
    expect(add?.findings.some((f) => f.severity === 'high')).toBe(true)
    const [rows] = sb.query<{ n: number }>("SELECT count(*) AS n FROM requests WHERE target_tool = 'sketchy__add'")
    expect(rows?.n).toBe(0)
    ev(`reply: "${replyText(res).slice(0, 160)}…"`)
    ev(`\`foreman mcp tools sketchy --json\`: add is quarantined (${add?.findings.length} findings); never reached the mediator (0 requests rows)`)
  })

  await j.step('a tool that is not on the hub goes through policy + risk: read_file of .env asks and times out', async (ev) => {
    const res = await agent.call('read_file', { path: 'config/.env' })
    expect(res.error?.message).toBe('Denied by approval-timeout')
    const row = await lastRequest('read_file')
    expect(row).toMatchObject({ decision: 'denied', decided_by: 'approval-timeout', risk_bucket: 'high' })
    ev(`requests ${row.id}: read_file config/.env → denied by approval-timeout, risk bucket high (secret_path)`)
  })

  await j.step('the agent disconnects cleanly', async (ev) => {
    expect(await agent.close()).toBe(0)
    ev('mcp-stdio exited 0 after stdin closed')
  })

  await j.step('rug pull: the server changes a pinned tool; the next session detects and blocks it', async (ev) => {
    sb.write('mcp.yaml', mcpYaml('changed'))
    const again = await McpAgent.connect(sb, 'claude-code', { FOREMAN_APPROVAL_TIMEOUT: '2' })
    const before = await again.toolNames()
    const res = await again.call('demo__echo', { text: 'should never run' })
    expect(res.result?.isError).toBe(true)
    expect(replyText(res)).toContain('definition changed since it was pinned (possible rug pull)')
    expect(replyText(res)).not.toContain('should never run')
    const after = await again.toolNames()
    expect(after).not.toContain('demo__echo')
    expect(after).toContain('demo__read_config')
    const blocked = await sb.event<McpCallEvent>('mcp:call', (e) => e.tool === 'echo' && e.isError)
    expect(blocked.error).toContain('possible rug pull')
    const row = await sb.row<RequestRow>('the rug-pull requests row', `${requestColumns} WHERE id = ?`, blocked.requestId)
    ev(`first tools/list of the session (pinned cache) still lists demo__echo: ${before.includes('demo__echo')}`)
    ev(`call reply: "${replyText(res).slice(0, 150)}…"`)
    ev('second tools/list: demo__echo withheld')
    ev(`audit_events mcp:call: tool=echo isError=true error="…possible rug pull…"; requests ${row.id}: decision=${row.decision} decided_by=${row.decided_by}`)
    if (row.decision === 'allowed') {
      j.note(
        `The rug-pull call is audited in \`requests\` (what \`foreman log tail\` shows) as "allowed by ${row.decided_by}", although the hub withheld it; the block is only visible in the mcp:call audit event.`,
      )
    }
    const refreshed = sb.json<HubTools>(['mcp', 'tools', 'demo', '--refresh', '--json'])
    const echo = refreshed.tools.find((t) => t.name === 'echo')
    expect(echo?.status).toBe('quarantined')
    expect(echo?.reasons.join(' ')).toContain('possible rug pull')
    ev('`foreman mcp tools demo --refresh --json`: echo quarantined, "definition changed since it was pinned"')
    const cached = sb.json<HubTools>(['mcp', 'tools', 'demo', '--json'])
    const cachedEcho = cached.tools.find((t) => t.name === 'echo')
    if (cachedEcho?.status === 'available') {
      j.note(
        'Without --refresh, `foreman mcp tools demo` (the command the withheld message tells the user to run) reads the pinned cache and shows echo as available, so the rug pull is not visible there.',
      )
    }
    await again.close()
  })

  await j.step('`foreman mcp trust demo` accepts the new definition and the tool works again', async (ev) => {
    const out = sb.ok(['mcp', 'trust', 'demo'])
    const agent3 = await McpAgent.connect(sb, 'claude-code')
    expect(await agent3.toolNames()).toContain('demo__echo')
    const res = await agent3.call('demo__echo', { text: 'trusted again' })
    expect(replyText(res)).toBe('trusted again')
    await agent3.close()
    ev(`trust output: "${out.trim().split('\n')[0]}"; demo__echo listed and returns "trusted again"`)
  })

  await j.step('nothing tried to reach the network', (ev) => {
    expect(sb.networkAttempts()).toEqual([])
    ev('network guard: 0 non-loopback connection attempts')
  })
})
