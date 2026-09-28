import { readFileSync, writeFileSync } from 'node:fs'
import { parseDocument } from 'yaml'
import { afterEach, expect, it } from 'vitest'
import { FakeSlack, type SlackMessage } from '../support/fake-slack.js'
import { Journey } from '../support/journey.js'
import { agentToken, McpAgent, replyText } from '../support/mcp-agent.js'
import { Sandbox, waitFor } from '../support/sandbox.js'
import { PTY_AVAILABLE, PTY_SKIP_REASON, Tui } from '../support/tui.js'

// =============================================================================
// A company on Slack: Finance, Marketing and IT, each with its own channel
// and a stand-in agent. Foreman and the boss are in every channel.
// =============================================================================

interface CommandEvent {
  command: string
  args: string[]
  sourceAgent: string
  sourceUser: string | null
  ok: boolean
  errorCode: string | null
}

interface OrgMessageEvent {
  sourceAgent: string
  ok: boolean
  channel: string | null
}

interface Decision {
  decision: string
  decided_by: string
}

/** Fake tokens: only the fake Slack on 127.0.0.1 ever sees them. */
const BOT_TOKEN = 'xoxb-qa-fake-bot-token'
const APP_TOKEN = 'xapp-qa-fake-app-token'
/** The boss: allowed and the only owner. */
const BOSS = 'U0BOSS'
/** The IT lead (a person): may decide approvals and run /foreman, but is
 *  not an owner, so can't change integrations. */
const TEAMMATE = 'U0ITLEAD'
/** In the workspace, but not in allowed_user_ids. */
const STRANGER = 'U0STRANGER'

/** Department → [head role, head agent, Slack channel]. */
const DEPARTMENTS = {
  finance: { name: 'Finance', head: 'cfo', agent: 'fin-lead', channel: '#finance' },
  marketing: { name: 'Marketing', head: 'cmo', agent: 'mkt-lead', channel: '#marketing' },
  it: { name: 'IT', head: 'cio', agent: 'it-lead', channel: '#it' },
} as const
/** Marketing's non-head: a content writer. */
const WRITER = 'mkt-writer'
/** Where approvals and alerts go (notify.yaml `channel`). */
const ALERTS = '#foreman'
const COST_USD = 2.5

let sandbox: Sandbox | null = null
let fakeSlack: FakeSlack | null = null
afterEach(async () => {
  await sandbox?.dispose()
  await fakeSlack?.close()
  sandbox = null
  fakeSlack = null
})

it('A company on Slack: department channels, approvals, budgets and integrations from chat', async (context) => {
  const j = new Journey(
    context.task,
    'company-slack',
    'Finance, Marketing and IT, each run by a stand-in agent and mirrored to its own Slack channel, with two-way Slack against a fake Slack on 127.0.0.1 (Web API, reply URLs and Socket Mode). Agents talk in their department channels, the boss decides approvals with buttons, a budget overrun pauses Marketing, reports and integration changes run from `/foreman`, and every step is in the audit trail.',
  )
  const sb = (sandbox = await Sandbox.create('company-slack'))
  const slack = (fakeSlack = await FakeSlack.start({ bot: BOT_TOKEN, app: APP_TOKEN }))
  // Every Foreman process talks to the fake Slack (slack-endpoints.ts only
  // takes http://127.0.0.1:<port>).
  sb.env.FOREMAN_TEST_SLACK_ORIGIN = slack.origin
  sb.ok(['init'])

  await j.step('the company: Finance, Marketing and IT in org.yaml, each mirrored to its own Slack channel', (ev) => {
    sb.write(
      'org.yaml',
      [
        '# Foreman Org — Acme QA. Docs: docs/org.md',
        'version: 1',
        'company: "Acme QA"',
        'human:',
        '  title: Founder',
        'delegation:',
        '  cross_department: via_heads',
        '  skip_levels: true',
        'departments:',
        '  finance:',
        '    name: Finance',
        '    head: cfo',
        'roles:',
        '  cfo:',
        '    title: Chief Financial Officer',
        '    agent: fin-lead',
        '    department: finance',
        '    reports_to: human',
        '',
      ].join('\n'),
    )
    expect(sb.run(['org', 'validate']).status).toBe(0)
    for (const id of ['marketing', 'it'] as const) {
      const d = DEPARTMENTS[id]
      expect(sb.ok(['org', 'add-department', id, '--head', d.head, '--agent', d.agent, '--name', d.name])).toContain(`added ${id}, led by ${d.head}`)
    }
    for (const [id, d] of Object.entries(DEPARTMENTS)) {
      expect(sb.ok(['org', 'channel', id, 'slack', d.channel])).toContain(d.channel)
    }
    expect(sb.ok(['org', 'add-role', 'writer', '--agent', WRITER, '--department', 'marketing', '--title', 'Content writer'])).toContain(
      'reporting to cmo',
    )
    expect(sb.ok(['org', 'budget', 'marketing', '1', '--pause'])).toContain("marketing: $1 per month · agents pause when it's spent")
    for (const id of [...Object.values(DEPARTMENTS).map((d) => d.agent), WRITER]) agentToken(sb, id)
    expect(sb.run(['org', 'validate']).status).toBe(0)
    const show = sb.ok(['org', 'show'])
    for (const d of Object.values(DEPARTMENTS)) expect(show).toContain(d.agent)
    const yaml = sb.read('org.yaml')
    expect(yaml).toMatch(/budget:[\s\S]*monthly_usd: 1[\s\S]*on_exceed: pause/)
    ev('org.yaml by hand: Finance (cfo = fin-lead); org add-department marketing (cmo = mkt-lead), it (cio = it-lead); org add-role writer (mkt-writer) → cmo')
    ev('org channel finance/marketing/it slack #finance/#marketing/#it; org budget marketing 1 --pause; cross_department: via_heads')
    ev('4 stand-in agents registered with identity tokens (foreman agent add --type generic-mcp); org validate exits 0')
  })

  await j.step('two-way Slack: tokens in the secret store, the boss and the IT lead allowed, only the boss an owner', async (ev) => {
    sb.ok(['secrets', 'add', 'slack-bot-token'], { input: `${BOT_TOKEN}\n` })
    sb.ok(['secrets', 'add', 'slack-app-token'], { input: `${APP_TOKEN}\n` })
    sb.ok(['notify', 'enable', 'slack', '--channel', ALERTS])
    // The app token is checked against (fake) Slack before it is saved;
    // async, so this process keeps serving the fake meanwhile.
    const opens = slack.calls.filter((c) => c.method === 'apps.connections.open').length
    expect(await sb.okAsync(['notify', 'slack-interactive', '--user', BOSS, '--user', TEAMMATE])).toContain(`two-way Slack is on for ${BOSS}, ${TEAMMATE}`)
    const check = slack.calls.filter((c) => c.method === 'apps.connections.open')
    expect(check).toHaveLength(opens + 1)
    expect(check.at(-1)?.token).toBe(APP_TOKEN)
    const path = sb.path('notify.yaml')
    const doc = parseDocument(readFileSync(path, 'utf-8'))
    doc.setIn(['channels', 'slack', 'owner_user_ids'], [BOSS])
    writeFileSync(path, doc.toString())
    expect(sb.ok(['notify', 'route', 'critical', 'slack'])).toContain('critical → slack')
    expect(sb.ok(['notify', 'route', 'budget_alert', 'slack'])).toContain('budget_alert → slack')
    const yaml = sb.read('notify.yaml')
    expect(yaml).not.toContain(BOT_TOKEN)
    expect(yaml).not.toContain(APP_TOKEN)
    ev(`secrets slack-bot-token + slack-app-token; notify enable slack --channel ${ALERTS}; notify slack-interactive --user ${BOSS} --user ${TEAMMATE} (verified: apps.connections.open with the app token on the fake Slack)`)
    ev(`notify.yaml: owner_user_ids [${BOSS}]; routes critical → slack, budget_alert → slack; neither token appears in notify.yaml`)
  })

  await j.step('a GitHub integration for IT, enabled (no network: no review)', (ev) => {
    sb.ok(['integrations', 'add', 'github', '--token-stdin', '--agents', 'it-lead', '--no-review'], { input: `ghp_${'Q'.repeat(36)}\n` })
    sb.ok(['integrations', 'enable', 'github', '--force'])
    const list = sb.json<Array<{ name: string; enabled: boolean }>>(['integrations', 'list', '--json'])
    expect(list).toEqual([expect.objectContaining({ name: 'github', enabled: true })])
    ev('foreman integrations add github --token-stdin --agents it-lead --no-review; enable --force; integrations list --json: github enabled')
  })

  const write = async (from: string, to: string, text: string) => {
    const agent = await McpAgent.connect(sb, from)
    const res = await agent.call('submit_command', { command: 'write', args: [to, ...text.split(' ')] })
    await agent.close()
    return res
  }

  await j.step('(e) cross-department: Finance handing work straight to a Marketing non-head is refused and audited', async (ev) => {
    const check = sb.run(['org', 'check', 'fin-lead', WRITER])
    expect(check.status).toBe(1)
    expect(check.stdout).toContain('blocked')
    const res = await write('fin-lead', WRITER, 'draft the Q3 pricing post')
    expect(res.result?.isError).toBe(true)
    expect(replyText(res)).toContain('Blocked by the org chart')
    expect(replyText(res)).toContain('cross-department work goes through department heads')
    const refused = await sb.event<CommandEvent>('foreman:command', (e) => e.errorCode === 'ORG_POLICY')
    expect(refused).toMatchObject({ command: 'write', sourceAgent: 'fin-lead', ok: false })
    const rows = sb.query<{ n: number }>("SELECT count(*) AS n FROM control_commands WHERE command = 'write'")
    expect(rows[0]?.n).toBe(0)
    const heads = sb.run(['org', 'check', 'fin-lead', 'mkt-lead'])
    expect(heads.status).toBe(0)
    ev(`org check fin-lead ${WRITER}: "${check.stdout.trim()}" (exit 1)`)
    ev(`fin-lead → ${WRITER}: "${replyText(res).slice(0, 160)}"`)
    ev('audit_events foreman:command: write from fin-lead ok=false errorCode=ORG_POLICY; control_commands has no write')
    ev(`org check fin-lead mkt-lead: "${heads.stdout.trim()}" (heads coordinate directly)`)
  })

  await j.step('(f) an agent relaying `/foreman integration disable github` is refused: agents may only read integrations', async (ev) => {
    const agent = await McpAgent.connect(sb, 'it-lead')
    const list = await agent.call('submit_command', { command: 'integrations', args: [] })
    expect(replyText(list)).toContain('github')
    const res = await agent.call('submit_command', { command: 'integration', args: ['disable', 'github'] })
    await agent.close()
    expect(res.result?.isError).toBe(true)
    expect(replyText(res)).toContain('Only you can disable an integration')
    const refused = await sb.event<CommandEvent>('foreman:command', (e) => e.command === 'integration')
    expect(refused).toMatchObject({ sourceAgent: 'it-lead', ok: false, errorCode: 'NOT_AUTHORIZED' })
    const after = sb.json<Array<{ name: string; enabled: boolean }>>(['integrations', 'list', '--json'])
    expect(after[0]?.enabled).toBe(true)
    expect(sb.events('integration:disabled')).toEqual([])
    ev(`it-lead submit_command integrations: lists github; integration disable github → "${replyText(res).slice(0, 140)}" (isError=true)`)
    ev('audit_events foreman:command: integration disable github from it-lead ok=false errorCode=NOT_AUTHORIZED; github still enabled; no integration:disabled event')
  })

  if (!PTY_AVAILABLE) {
    j.note(`Skipped the steps that need \`foreman start\` (department mirrors, approvals, budget alert, /foreman from Slack): ${PTY_SKIP_REASON}`)
    await j.step('nothing tried to reach the network', (ev) => {
      expect(sb.networkAttempts()).toEqual([])
      ev('network guard: 0 non-loopback connection attempts')
    })
    return
  }

  const tui = await Tui.start(sb)
  await tui.waitForDashboard()

  await j.step('`foreman start` opens Socket Mode on the fake Slack with the app token', async (ev) => {
    await slack.connected()
    const open = slack.calls.filter((c) => c.method === 'apps.connections.open').at(-1)
    expect(open?.token).toBe(APP_TOKEN)
    ev(`apps.connections.open (Bearer app token) → ${String(open?.response.url)}; hello sent, Foreman connected`)
  })

  await j.step('(a) each department talks in its own channel, and it shows up in that Slack channel', async (ev) => {
    const posts: Array<[string, string, string]> = [
      ['fin-lead', 'finance', 'invoices for September are out'],
      [WRITER, 'marketing', 'launch post draft is ready for review'],
      ['it-lead', 'it', 'laptops for the new hires are imaged'],
    ]
    for (const [from, to, text] of posts) {
      const agent = await McpAgent.connect(sb, from)
      const res = await agent.call('org_post', { to, text })
      await agent.close()
      expect(replyText(res)).toMatch(new RegExp(`^Posted to #${to}`))
    }
    for (const [from, to, text] of posts) {
      const channel = DEPARTMENTS[to as keyof typeof DEPARTMENTS].channel
      const m = await slack.message(`${from} in ${channel}`, (x) => x.text.includes(text))
      expect(m.channel).toBe(channel)
      expect(m.token).toBe(BOT_TOKEN)
      expect(m.text).toContain(from)
      expect(m.text).toContain(`> ${text}`)
      ev(`${from} org_post → #${to} → chat.postMessage ${m.channel}: "${m.text.replace(/\n/g, ' ')}"`)
    }
    // Nothing leaks into another department's channel.
    for (const d of Object.values(DEPARTMENTS)) {
      const own = posts.filter(([, to]) => DEPARTMENTS[to as keyof typeof DEPARTMENTS].channel === d.channel).map(([, , t]) => t)
      expect(slack.messages(d.channel).map((m) => m.text.split('\n').at(-1)?.slice(2))).toEqual(own)
    }
    ev('each Slack channel holds only its own department\'s message')
    const events = sb.events<OrgMessageEvent>('org:message').filter((e) => e.ok)
    expect(events.map((e) => e.sourceAgent).sort()).toEqual(['fin-lead', 'it-lead', WRITER].sort())
    ev('audit_events org:message: 3 ok (fin-lead, mkt-writer, it-lead)')
  })

  /** A risky call from it-lead; resolves once its approval is in Slack. */
  const riskyCall = async (agent: McpAgent, path: string) => {
    const reply = agent.call('read_file', { path }, 90_000)
    const pending = await sb.row<{ request_id: string; risk_bucket: string }>(
      'the pending approval',
      "SELECT request_id, risk_bucket FROM pending_approvals WHERE args LIKE ? AND status = 'pending'",
      `%${path}%`,
    )
    const message = await slack.message('the approval', (m) => m.channel === ALERTS && JSON.stringify(m.body.blocks ?? []).includes('foreman_allow') && m.text.includes(path))
    return { reply, requestId: pending.request_id, risk: pending.risk_bucket, message }
  }

  const buttonIds = (m: SlackMessage): string[] =>
    ((m.body.blocks ?? []) as Array<{ type?: string; elements?: Array<{ action_id?: string }> }>)
      .flatMap((b) => (b.type === 'actions' ? (b.elements ?? []) : []))
      .map((e) => e.action_id ?? '')

  let allowedId = ''
  let deniedId = ''
  await j.step('(b) approvals in Slack: the boss taps Allow, a stranger is refused, the IT lead taps Deny', async (ev) => {
    const agent = await McpAgent.connect(sb, 'it-lead', { FOREMAN_APPROVAL_TIMEOUT: '90' })

    const first = await riskyCall(agent, 'ops/.env')
    allowedId = first.requestId
    expect(buttonIds(first.message)).toEqual(expect.arrayContaining(['foreman_allow', 'foreman_deny']))
    ev(`it-lead read_file(ops/.env) → pending ${first.requestId} (risk ${first.risk}) → chat.postMessage ${ALERTS} "${first.message.text.split('\n')[0]}", buttons [${buttonIds(first.message).join(', ')}]`)
    const allow = slack.tap(BOSS, first.message, 'foreman_allow')
    await slack.acked(allow.envelopeId)
    const res = await first.reply
    expect(res.error).toBeUndefined()
    ev(`${BOSS} taps Allow (acked); agent reply: "${replyText(res)}"`)
    const outcome = await slack.hook('the outcome', allow.path)
    expect(outcome.body).toMatchObject({ replace_original: true, text: `Allowed ✓ by <@${BOSS}>` })
    expect(JSON.stringify(outcome.body.blocks)).not.toContain('foreman_allow')
    ev(`reply on response_url: replace_original, "${String(outcome.body.text)}", buttons gone`)
    const row = await sb.row<Decision>('the requests row', 'SELECT decision, decided_by FROM requests WHERE id = ?', first.requestId)
    expect(row.decision).toBe('allowed')
    ev(`requests ${first.requestId}: allowed, decided_by=${row.decided_by}`)

    const second = await riskyCall(agent, 'finance/.aws/credentials')
    deniedId = second.requestId
    const intruder = slack.tap(STRANGER, second.message, 'foreman_allow')
    await slack.acked(intruder.envelopeId)
    const refusal = await slack.hook('the refusal', intruder.path)
    expect(refusal.body).toMatchObject({ response_type: 'ephemeral', replace_original: false, text: 'You are not allowed to decide Foreman approvals.' })
    const still = sb.query<{ status: string }>('SELECT status FROM pending_approvals WHERE request_id = ?', second.requestId)
    expect(still[0]?.status).toBe('pending')
    ev(`${STRANGER} taps Allow on ${second.requestId}: "${String(refusal.body.text)}" (ephemeral); the approval stays pending`)
    const deny = slack.tap(TEAMMATE, second.message, 'foreman_deny')
    await slack.acked(deny.envelopeId)
    const denied = await second.reply
    expect(denied.error?.message).toMatch(/^Denied by/)
    const denyOutcome = await slack.hook('the deny outcome', deny.path)
    expect(denyOutcome.body).toMatchObject({ replace_original: true, text: `Denied ✗ by <@${TEAMMATE}>` })
    const row2 = await sb.row<Decision>('the requests row', 'SELECT decision, decided_by FROM requests WHERE id = ?', second.requestId)
    expect(row2.decision).toBe('denied')
    ev(`${TEAMMATE} taps Deny: agent error "${denied.error?.message}"; response_url: "${String(denyOutcome.body.text)}"; requests: denied, decided_by=${row2.decided_by}`)

    // requests.decided_by only says "user:slack"; the audit log names the person.
    const decisions = await waitFor('two channel decisions', () => {
      const e = sb.events<{ requestId: string; channel: string; decidedBy: string; decision: string }>('approval:channel-decision')
      return e.length >= 2 ? e : null
    })
    expect(decisions.map(({ requestId, channel, decidedBy, decision }) => ({ requestId, channel, decidedBy, decision }))).toEqual([
      { requestId: first.requestId, channel: 'slack', decidedBy: `slack:${BOSS}`, decision: 'allow' },
      { requestId: second.requestId, channel: 'slack', decidedBy: `slack:${TEAMMATE}`, decision: 'deny' },
    ])
    ev(`audit_events approval:channel-decision: ${decisions.map((d) => `${d.decision} by ${d.decidedBy}`).join(', ')} (the stranger's tap is not a decision)`)
    const updates = await waitFor('the approval messages edited', () => {
      const u = slack.calls.filter((c) => c.method === 'chat.update')
      return u.length >= 2 ? u : null
    })
    expect(updates.map((u) => u.body.ts)).toEqual([first.message.ts, second.message.ts])
    expect(updates.every((u) => !JSON.stringify(u.body.blocks).includes('foreman_allow'))).toBe(true)
    ev(`chat.update on both approval messages (${updates.map((u) => String(u.body.ts)).join(', ')}): the outcome replaces the buttons`)
    await agent.close()
  })

  await j.step('(c) a budget overrun: Marketing spends past $1, Slack gets the alert, and delegation into Marketing pauses', async (ev) => {
    const env = sb.ok(['usage', 'env', 'mkt-lead'])
    const key = /x-foreman-usage-key=(\S+)/.exec(env)?.[1]
    expect(key).toMatch(/^u1\.mkt-lead\./)
    const port = Number(sb.env.FOREMAN_OTLP_PORT)
    const res = await waitFor('the OTLP receiver', () =>
      fetch(`http://127.0.0.1:${port}/v1/logs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-foreman-usage-key': key ?? '' },
        body: JSON.stringify(apiRequestLog()),
      }).catch(() => null),
    )
    expect(res.status).toBe(200)
    const usage = await sb.row<{ agent_id: string; department: string; cost_usd: number }>(
      'the usage row',
      'SELECT agent_id, department, cost_usd FROM agent_usage',
    )
    expect(usage).toEqual({ agent_id: 'mkt-lead', department: 'marketing', cost_usd: COST_USD })
    ev(`foreman usage env mkt-lead → per-agent key; OTLP POST (payload claims claude-code) → 200; agent_usage: mkt-lead, marketing, $${usage.cost_usd}`)

    const alert = await slack.message('the budget alert', (m) => m.channel === ALERTS && m.text.includes('Marketing is over its monthly budget'))
    expect(alert.text).toContain('$2.50 of $1.00')
    expect(alert.text).toContain("agents can't hand it new work")
    ev(`chat.postMessage ${ALERTS}: "${alert.text.replace(/\n/g, ' ')}"`)
    const item = await sb.inboxItem('the budget alert', (i) => i.kind === 'budget')
    expect(item).toMatchObject({ level: 'critical', title: 'Marketing is over its monthly budget' })
    ev(`inbox: [${item.level}] "${item.title}"`)

    const paused = await write('fin-lead', 'mkt-lead', 'run the Q3 campaign')
    expect(paused.result?.isError).toBe(true)
    expect(replyText(paused)).toContain('Paused by budget: Marketing is over its monthly budget ($2.50 of $1.00)')
    const refused = sb.events<CommandEvent>('foreman:command').filter((e) => e.errorCode === 'ORG_POLICY')
    expect(refused.map((e) => e.sourceAgent)).toEqual(['fin-lead', 'fin-lead'])
    ev(`fin-lead (head) → mkt-lead (head), allowed by the chart: "${replyText(paused).slice(0, 120)}"`)
  })

  await j.step('(d) `/foreman report marketing` from Slack returns the report', async (ev) => {
    const cmd = slack.slash(BOSS, 'report marketing')
    await slack.acked(cmd.envelopeId)
    const reply = await slack.hook('the report', cmd.path)
    const text = String(reply.body.text)
    expect(reply.body).toMatchObject({ response_type: 'ephemeral' })
    expect(text).toContain('/foreman report marketing')
    expect(text).toContain('Marketing · today')
    expect(text).toContain('Spend $2.50')
    expect(text).toMatch(/Budget marketing \(month\): \$2\.50 of \$1\.00/)
    ev(`${BOSS} /foreman report marketing → ephemeral reply: "${text.split('\n').slice(0, 4).join(' | ')}"`)
    const stranger = slack.slash(STRANGER, 'report marketing')
    await slack.acked(stranger.envelopeId)
    const refused = await slack.hook('the refusal', stranger.path)
    expect(refused.body.text).toBe('You are not allowed to command Foreman.')
    ev(`${STRANGER} /foreman report marketing → "${String(refused.body.text)}"`)
  })

  await j.step('(f) integrations from Slack: the boss lists and disables; the IT lead (not an owner) is refused', async (ev) => {
    const list = slack.slash(BOSS, 'integrations')
    await slack.acked(list.envelopeId)
    const listed = String((await slack.hook('the list', list.path)).body.text)
    expect(listed).toContain('github — read-only, not reviewed, it-lead')
    ev(`${BOSS} /foreman integrations → "${listed.replace(/\n/g, ' | ')}"`)

    const teammate = slack.slash(TEAMMATE, 'integration disable github')
    await slack.acked(teammate.envelopeId)
    const refusedText = String((await slack.hook('the refusal', teammate.path)).body.text)
    expect(refusedText).toContain('Only you can disable an integration')
    expect(sb.json<Array<{ enabled: boolean }>>(['integrations', 'list', '--json'])[0]?.enabled).toBe(true)
    ev(`${TEAMMATE} /foreman integration disable github → "${refusedText.replace(/\n/g, ' | ').slice(0, 160)}"; github still enabled`)

    const boss = slack.slash(BOSS, 'integration disable github')
    await slack.acked(boss.envelopeId)
    const done = String((await slack.hook('the change', boss.path)).body.text)
    expect(done).toContain('github disabled — connected agents lost it.')
    expect(sb.json<Array<{ enabled: boolean }>>(['integrations', 'list', '--json'])[0]?.enabled).toBe(false)
    const item = await sb.inboxItem('the change', (i) => i.title === `github disabled from Slack by ${BOSS}`)
    const disabled = await sb.event<{ server: string; via: string; actor?: string }>('integration:disabled')
    expect(disabled).toMatchObject({ server: 'github', via: 'slack', actor: BOSS })
    ev(`${BOSS} /foreman integration disable github → "${done}"; integrations list: github disabled`)
    ev(`inbox: "${item.title}"; audit_events integration:disabled { server: github, via: slack, actor: ${BOSS} }`)
  })

  await j.step('(g) the audit trail has all of it: `foreman log tail --json`, audit events and the inbox', async (ev) => {
    const log = sb.json<Array<{ id: string; toolName: string; decision: string; decidedBy: string; agentId?: string; sourceAgent?: string }>>(['log', 'tail', '--json', '-n', '20'])
    expect(log.find((r) => r.id === allowedId)).toMatchObject({ decision: 'allowed' })
    expect(log.find((r) => r.id === deniedId)).toMatchObject({ decision: 'denied' })
    ev(`log tail --json: ${allowedId} ${log.find((r) => r.id === allowedId)?.decision} by ${log.find((r) => r.id === allowedId)?.decidedBy}; ${deniedId} ${log.find((r) => r.id === deniedId)?.decision} by ${log.find((r) => r.id === deniedId)?.decidedBy}`)

    const fromSlack = sb.events<CommandEvent>('foreman:command').filter((e) => e.sourceAgent === 'slack')
    expect(fromSlack.map((e) => `${e.sourceUser} ${e.command} ${e.args.join(' ')}`.trim())).toEqual([
      `slack:${BOSS} report marketing`,
      `slack:${BOSS} integrations`,
      `slack:${TEAMMATE} integration disable github`,
      `slack:${BOSS} integration disable github`,
    ])
    expect(fromSlack.map((e) => e.ok)).toEqual([true, true, false, true])
    expect(fromSlack[2]?.errorCode).toBe('NOT_AUTHORIZED')
    ev(`audit_events foreman:command from slack: ${fromSlack.map((e) => `${e.sourceUser} "${[e.command, ...e.args].join(' ')}" ok=${e.ok}`).join('; ')}`)
    const relayed = sb.events<CommandEvent>('foreman:command').filter((e) => e.sourceAgent === 'it-lead' && e.command === 'integration')
    expect(relayed).toEqual([expect.objectContaining({ ok: false, errorCode: 'NOT_AUTHORIZED' })])
    ev('audit_events foreman:command from it-lead: integration disable github ok=false errorCode=NOT_AUTHORIZED')
    const disabled = sb.events<{ server: string; via: string; actor?: string }>('integration:disabled')
    expect(disabled.map((e) => `${e.server} ${e.via} ${e.actor ?? ''}`)).toEqual([`github slack ${BOSS}`])
    ev(`audit_events integration:disabled: exactly one, github via slack by ${BOSS}`)
    const orgPolicy = sb.events<CommandEvent>('foreman:command').filter((e) => e.errorCode === 'ORG_POLICY')
    expect(orgPolicy).toHaveLength(2)
    ev('audit_events foreman:command ORG_POLICY: fin-lead → mkt-writer (chart), fin-lead → mkt-lead (budget)')
    const inbox = await sb.inbox(100)
    for (const title of ['Marketing is over its monthly budget', `github disabled from Slack by ${BOSS}`]) {
      expect(inbox.some((i) => i.title === title)).toBe(true)
    }
    expect(inbox.some((i) => i.requestId === allowedId && i.title.startsWith('Allowed'))).toBe(true)
    expect(inbox.some((i) => i.requestId === deniedId && i.title.startsWith('Denied'))).toBe(true)
    ev(`inbox: ${inbox.filter((i) => i.requestId === allowedId || i.requestId === deniedId).map((i) => `"${i.title}" / "${i.body}"`).join('; ')}`)
  })

  await j.step('`foreman start` shuts down cleanly and closes Socket Mode; nothing tried to reach the network', async (ev) => {
    expect(await tui.stop()).toBe(0)
    expect(slack.calls.every((c) => c.method === 'apps.connections.open' ? c.token === APP_TOKEN : c.token === BOT_TOKEN)).toBe(true)
    expect(sb.networkAttempts()).toEqual([])
    ev(`${slack.calls.length} Web API calls (${[...new Set(slack.calls.map((c) => c.method))].join(', ')}), each with the right token; ${slack.hooks.length} replies on response_url`)
    ev('network guard: 0 non-loopback connection attempts')
  })
})

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
                  kv('cost_usd', { doubleValue: COST_USD }),
                  kv('session.id', { stringValue: 'qa-marketing-1' }),
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}
