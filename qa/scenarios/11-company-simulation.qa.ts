import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Journey } from '../support/journey.js'
import { agentToken, McpAgent, replyText } from '../support/mcp-agent.js'
import { DEMO_SERVER, FOREMAN_BIN, Sandbox, sleep, waitFor } from '../support/sandbox.js'
import { KEY_SETTLE_MS, PTY_AVAILABLE, PTY_SKIP_REASON, Tui } from '../support/tui.js'

// =============================================================================
// A company of agents, simulated step by step
// =============================================================================
//
// The startup org chart (CEO, CTO, engineer, CMO, CFO, support lead), each
// role filled by a stand-in that behaves like its agent
// (qa/support/company-agent.cjs): Hermes, OpenClaw and ZeroClaw speak ACP,
// Claude Code and Codex take a task on the command line, and each one does
// what the playbook below says, handing work on with `foreman write` as
// itself. The background service's gateway runs the work, with no TUI.
// When the work an agent handed off is back, Foreman launches it again with
// the results (delegation-loop.ts), so the chain unwinds up to the CEO.

const AGENT_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'support', 'company-agent.cjs')

/** A wake (results back) starts with this line; wake rules come first, as
 *  a wake repeats the original task that the other rules match. */
const WAKE = 'the work you handed off is back'

/** What each stand-in does with a task (first matching `when`). */
const PLAYBOOK = {
  hermes: [
    { when: WAKE, reply: 'Launch on track: the login page is built and tested, the announcement is drafted.' },
    {
      when: 'launch',
      reply: 'Plan: the CTO builds it, the CMO announces it.',
      delegate: [
        ['claude-code', 'Build the login page'],
        ['openclaw', 'Announce the login feature'],
      ],
    },
  ],
  'claude-code': [
    { when: WAKE, reply: 'Login page built; the engineer wrote its tests.' },
    { when: 'login page', reply: 'Building the login page; the engineer writes the tests.', delegate: [['codex', 'Write tests for the login page']] },
  ],
  openclaw: [
    { when: WAKE, reply: 'Announcement ready with the launch banner.' },
    { when: 'announce', reply: 'Announcement drafted for Friday.', delegate: [['claude-code', 'Add a launch banner to the site']] },
  ],
  // Finance reaches past the engineering head: the chart must stop it.
  zeroclaw: [{ when: 'budget', reply: 'Budget review started.', delegate: [['codex', 'Cut cloud costs in the build pipeline']] }],
} as const

const ROLES = ['hermes', 'claude-code', 'codex', 'openclaw', 'zeroclaw', 'generic-mcp'] as const

interface CommandRow {
  id: number
  args: string
  source_agent: string
  status: string
  error: string | null
}

interface DelegationRow {
  initiatorAgent: string
  targetAgent: string
  promptSummary: string
  status: string
  spawnOutcome: string | null
}

interface AgentLogLine {
  agent: string
  task: string
  spawnedBy: string | null
  depth: string | null
}

let sandbox: Sandbox | null = null
afterEach(async () => {
  await sandbox?.dispose()
  sandbox = null
})

it('A company of agents: goals flow down the chart, agents talk, the chart and your approvals hold', async (context) => {
  const j = new Journey(
    context.task,
    'company-simulation',
    'The startup org chart run by six stand-in agents (three of them speak ACP like Hermes, OpenClaw and ZeroClaw). The owner gives the CEO a goal; it is split down the chart (CEO → CTO → engineer, CEO → CMO → CTO) and every hop runs, answers and is audited. Agents then talk in department channels, report to their managers and hear an all-hands message. Finance reaching past a department head is stopped. An engineer\'s approval is first reviewed by its manager, then decided by the owner in the TUI. The background service runs it all with no terminal open.',
  )
  const sb = (sandbox = await Sandbox.create('company'))
  const bin = join(sb.root, 'bin')
  const agentLog = join(sb.root, 'agent-tasks.jsonl')
  const playbook = join(sb.root, 'playbook.json')
  const commands = (): CommandRow[] =>
    sb.query<CommandRow>("SELECT id, args, source_agent, status, error FROM control_commands WHERE command = 'write' ORDER BY id")
  const finished = (): CommandRow[] => commands().filter((c) => c.status === 'applied' || c.status === 'failed')
  const handoff = (c: CommandRow): string => `${c.source_agent} → ${JSON.parse(c.args)[0]}: ${JSON.parse(c.args)[1]}`
  const agentTasks = (): AgentLogLine[] =>
    existsSync(agentLog) ? readFileSync(agentLog, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as AgentLogLine) : []

  await j.step('the company: `org init --template startup`, six agents registered, stand-ins that act like them', (ev) => {
    sb.ok(['init'])
    expect(sb.ok(['org', 'init', '--template', 'startup', '--company', 'Acme QA'])).toContain('wrote')
    for (const id of ROLES) agentToken(sb, id)
    // The agents Foreman runs, and `foreman` for the stand-ins to call.
    const exe = (name: string, body: string): void => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(join(bin, name), 0o755)
    }
    exe('foreman', `exec "${process.execPath}" "${FOREMAN_BIN}" "$@"`)
    exe('claude', `exec node "${AGENT_JS}" claude-code task "$@"`)
    exe('codex', `exec node "${AGENT_JS}" codex task "$@"`)
    for (const id of ['hermes', 'openclaw', 'zeroclaw']) exe(id, `exec node "${AGENT_JS}" ${id} "$@"`)
    writeFileSync(playbook, JSON.stringify(PLAYBOOK, null, 2))
    sb.env.QA_PLAYBOOK = playbook
    sb.env.QA_AGENT_LOG = agentLog
    const show = sb.ok(['org', 'show'])
    for (const [role, agent] of [['ceo', 'hermes'], ['cto', 'claude-code'], ['engineer', 'codex'], ['cmo', 'openclaw'], ['cfo', 'zeroclaw']]) {
      expect(show).toMatch(new RegExp(`${role}\\b.*● ${agent}`))
    }
    ev('org.yaml from the startup template: ceo=hermes, cto=claude-code, engineer=codex, cmo=openclaw, cfo=zeroclaw, support-lead=generic-mcp; all ● registered')
    ev('stand-ins on PATH: hermes/openclaw/zeroclaw speak ACP, claude/codex take the task as argv; each follows the playbook and hands work on with `foreman write`')
  })

  let service: ChildProcess | null = null
  let serviceLog = ''
  await j.step('the background service runs the gateway (no TUI)', async (ev) => {
    const child = spawn(process.execPath, [FOREMAN_BIN, 'daemon', '--service'], {
      cwd: sb.cwd,
      env: { ...sb.env, NO_COLOR: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    child.stderr!.setEncoding('utf-8').on('data', (c: string) => (serviceLog += c))
    sb.onDispose(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((r) => child.once('exit', r))
        child.kill('SIGKILL')
        await exited
      }
    })
    service = child
    await waitFor('the service daemon to listen', () => serviceLog.includes('daemon: listening on'), { timeoutMs: 30_000 })
    expect(readFileSync(sb.path('foreman.pid'), 'utf-8')).toBe(`${child.pid}\nheadless\n`)
    ev(`foreman daemon --service (pid ${child.pid}) holds the home as the headless gateway`)
  })

  await j.step('the owner gives the CEO a goal; it flows down the chart and every hop runs', async (ev) => {
    const out = sb.ok(['org', 'assign', 'ceo', 'Launch the login feature by Friday'])
    expect(out).toContain('ceo')
    expect(out).toContain('hermes')
    ev(`foreman org assign ceo "Launch the login feature by Friday": "${out.trim().split('\n')[0]}"`)
    // CEO → CTO and CMO; CTO → engineer; CMO → CTO (heads coordinate).
    // Then the results come back: CTO and CMO are woken with theirs, and
    // once both are done, the CEO with both.
    const all = await waitFor('five hand-offs and three wakes to finish', () => (finished().length >= 8 ? finished() : null), {
      timeoutMs: 120_000,
      intervalMs: 300,
    })
    const rows = all.filter((r) => r.source_agent !== 'foreman:delegation')
    expect(rows.map(handoff).sort()).toEqual(
      [
        'cli → hermes: Launch the login feature by Friday',
        'hermes → claude-code: Build the login page',
        'hermes → openclaw: Announce the login feature',
        'claude-code → codex: Write tests for the login page',
        'openclaw → claude-code: Add a launch banner to the site',
      ].sort(),
    )
    expect(rows.every((r) => r.status === 'applied'), JSON.stringify(rows)).toBe(true)
    for (const r of rows) ev(`control_commands #${r.id} ${handoff(r)} → ${r.status}`)
    // Each agent ran as itself, one level deeper than whoever handed it the work.
    const tasks = agentTasks()
    const byTask = (task: string): AgentLogLine | undefined => tasks.find((t) => t.task === task)
    expect(byTask('Launch the login feature by Friday')).toMatchObject({ agent: 'hermes', spawnedBy: 'hermes', depth: '1' })
    expect(byTask('Build the login page')).toMatchObject({ agent: 'claude-code', spawnedBy: 'claude-code' })
    expect(byTask('Write tests for the login page')).toMatchObject({ agent: 'codex', spawnedBy: 'codex' })
    ev(`the stand-ins received ${tasks.length} tasks, each running as itself (FOREMAN_SPAWNED_BY) — e.g. ${JSON.stringify(byTask('Build the login page'))}`)

    const wakes = all.filter((r) => r.source_agent === 'foreman:delegation')
    expect(wakes.map((w) => JSON.parse(w.args)[0])).toEqual(['claude-code', 'openclaw', 'hermes'])
    expect(wakes.every((w) => w.status === 'applied'), JSON.stringify(wakes)).toBe(true)
    const ceoWake = JSON.parse(wakes[2]!.args)[1] as string
    expect(ceoWake).toContain('Your task (from the owner):\n    Launch the login feature by Friday')
    expect(ceoWake).toContain('claude-code finished "Build the login page":\n    Login page built; the engineer wrote its tests.')
    expect(ceoWake).toContain('openclaw finished "Announce the login feature":\n    Announcement ready with the launch banner.')
    expect(ceoWake).toContain('report to the owner with org_report')
    // The CEO (ACP) ran the wake as itself and answered it.
    const ceoRan = tasks.find((t) => t.agent === 'hermes' && t.task.startsWith('Foreman: the work you handed off is back.'))
    expect(ceoRan).toMatchObject({ spawnedBy: 'hermes' })
    ev(`results came back up the chart: foreman:delegation → ${wakes.map((w) => JSON.parse(w.args)[0]).join(' → ')}; the CEO's wake carries the CTO's and the CMO's final answers`)
  })

  await j.step("every agent's answer reaches your inbox, the CEO's streamed ACP reply included", async (ev) => {
    const ceo = await sb.inboxItem('the CEO result', (i) => i.title.startsWith('hermes finished: Launch'), 30_000)
    // The ACP reply streams in two chunks and ends with { stopReason }: the
    // inbox shows what the CEO said, not {"stopReason": "end_turn"}.
    expect(ceo.body).toContain('Plan: the CTO builds it, the CMO announces it.')
    expect(ceo.body).toContain('handed to claude-code: Build the login page')
    expect(ceo.body).not.toContain('stopReason')
    ev(`inbox "${ceo.title}": ${ceo.body.replace(/\n/g, ' | ')}`)
    for (const [agent, text] of [
      ['claude-code', 'handed to codex: Write tests for the login page'],
      ['codex', 'Done: Write tests for the login page'],
      ['openclaw', 'Announcement drafted for Friday.'],
    ] as const) {
      const item = await sb.inboxItem(`${agent}'s result`, (i) => i.title.startsWith(`${agent} finished`) && i.body.includes(text), 30_000)
      ev(`inbox "${item.title}": ${item.body.split('\n')[0]}`)
    }
    const delegations = sb.json<DelegationRow[]>(['delegations', 'list', '--recent', '--json'])
    const chain = delegations.map((d) => `${d.initiatorAgent} → ${d.targetAgent}`)
    expect(chain).toEqual(expect.arrayContaining(['hermes → claude-code', 'claude-code → codex', 'hermes → openclaw', 'openclaw → claude-code']))
    ev(`foreman delegations list --recent --json: ${chain.join(', ')}`)
  })

  const as = async <T>(agent: string, fn: (a: McpAgent) => Promise<T>): Promise<T> => {
    const a = await McpAgent.connect(sb, agent)
    try {
      return await fn(a)
    } finally {
      await a.close()
    }
  }

  await j.step('agents talk: department channels, reports to managers, leadership, an all-hands from you', async (ev) => {
    expect(replyText(await as('codex', (a) => a.call('org_post', { to: 'engineering', text: 'login tests are green' })))).toMatch(/^Posted to #engineering/)
    const report = await as('codex', (a) => a.call('org_report', { text: 'login page tests done' }))
    expect(replyText(report)).toMatch(/^Posted to (cto ↔ engineer|engineer ↔ cto)/)
    const cross = await as('codex', (a) => a.call('org_post', { to: 'marketing', text: 'tweet about the login page?' }))
    expect(cross.result?.isError).toBe(true)
    ev(`engineer → #engineering posted; engineer org_report → its manager; engineer → #marketing: "${replyText(cross)}"`)

    const ctoInbox = await as('claude-code', (a) => a.call('org_read', {}))
    expect(replyText(ctoInbox)).toContain('login page tests done')
    expect(replyText(await as('claude-code', (a) => a.call('org_post', { to: 'leadership', text: 'login ships Friday' })))).toMatch(/^Posted to #leadership/)
    const cmoSees = await as('openclaw', (a) => a.call('org_read', { channel: 'leadership' }))
    expect(replyText(cmoSees)).toContain('login ships Friday')
    ev("CTO reads the engineer's report with org_read; CTO → #leadership; the CMO reads it there")

    expect(sb.ok(['org', 'tell', 'all', 'Great work on the launch, team'])).toContain('posted to')
    const engineerSees = await as('codex', (a) => a.call('org_read', {}))
    expect(replyText(engineerSees)).toContain('Great work on the launch, team')
    const ceoReport = await as('hermes', (a) => a.call('org_report', { text: 'Launch on track for Friday' }))
    expect(replyText(ceoReport)).toMatch(/^Posted to/)
    const toYou = await sb.inboxItem("the CEO's report to you", (i) => i.kind === 'message' && i.title.startsWith('ceo (hermes) → you'), 20_000)
    ev(`org tell all → the engineer reads it; the CEO's org_report reaches your inbox: "${toYou.title}"`)
    const messages = sb.ok(['org', 'messages'])
    for (const text of ['login tests are green', 'login page tests done', 'login ships Friday', 'Great work on the launch, team', 'Launch on track for Friday']) {
      expect(messages).toContain(text)
    }
    expect(messages).not.toContain('tweet about the login page?')
    ev('foreman org messages: all five, not the refused cross-department post')
  })

  await j.step('the chart holds: finance cannot reach past the engineering head, from ACP or from MCP', async (ev) => {
    const before = commands().length
    sb.ok(['org', 'assign', 'cfo', 'Review the launch budget'])
    const cfo = await sb.inboxItem('the CFO result', (i) => i.title.startsWith('zeroclaw finished'), 60_000)
    // The CFO (ACP) ran `foreman write codex …` as itself, so the chart applied.
    expect(cfo.body).toContain('could not hand to codex')
    expect(cfo.body).toContain('org chart')
    ev(`CFO (zeroclaw, ACP) → engineer (codex) from inside its task: "${/could not hand to codex[^\n]*/.exec(cfo.body)?.[0] ?? ''}"`)
    const viaMcp = await as('zeroclaw', (a) => a.call('submit_command', { command: 'write', args: ['codex', 'cut', 'costs'] }))
    expect(viaMcp.result?.isError).toBe(true)
    expect(replyText(viaMcp)).toContain('Blocked by the org chart')
    const after = commands()
    expect(after.filter((c) => c.source_agent === 'zeroclaw')).toEqual([])
    expect(after.length).toBe(before + 1)
    ev(`and over MCP: "${replyText(viaMcp).slice(0, 110)}…"; control_commands gained only the owner's assignment`)
  })

  await j.step("an engineer's approval is reviewed by its manager first, then decided by you", async (ev) => {
    // The engineering department sees the `github` hub server (the QA demo
    // server under that name). `big_report` has no rule, so it asks.
    sb.write(
      'mcp.yaml',
      ['servers:', '  github:', `    command: ${JSON.stringify(process.execPath)}`, `    args: [${JSON.stringify(DEMO_SERVER)}]`, '    tools:', '      allow: [echo]', ''].join('\n'),
    )
    expect(sb.ok(['org', 'escalate', 'on'])).toContain("also go to the requester's manager agent")
    const engineer = await McpAgent.connect(sb, 'codex', { FOREMAN_APPROVAL_TIMEOUT: '120' })
    sb.onDispose(() => engineer.kill())
    const reply = engineer.call('github__big_report', {}, 150_000)
    const pending = await sb.row<{ request_id: string; risk_bucket: string }>(
      'the pending approval',
      "SELECT request_id, risk_bucket FROM pending_approvals WHERE status = 'pending'",
    )
    ev(`engineer → github__big_report: pending approval ${pending.request_id} (risk ${pending.risk_bucket})`)
    // The CTO is asked for advice on its report's call.
    const review = await waitFor(
      'the review request to the CTO',
      async () => {
        const text = replyText(await as('claude-code', (a) => a.call('org_read', {})))
        return /review_id: (rv_\S+)/.exec(text)?.[1] ?? null
      },
      { timeoutMs: 30_000, intervalMs: 1_000 },
    )
    const rec = await as('claude-code', (a) =>
      a.call('org_recommend', { review_id: review, recommendation: 'allow', reason: 'read-only report the engineer needs' }),
    )
    expect(replyText(rec)).toContain('The human sees it next to the approval and decides')
    const advice = await sb.inboxItem('the recommendation', (i) => i.kind === 'approval' && i.title.includes('recommends allow'), 20_000)
    ev(`CTO org_read → review ${review}; org_recommend allow → inbox "${advice.title}"`)
    // Advice only: still pending until you decide.
    expect(sb.query<{ status: string }>('SELECT status FROM pending_approvals WHERE request_id = ?', pending.request_id)[0]?.status).toBe('pending')

    if (!PTY_AVAILABLE) {
      j.note(`Skipped deciding in the attached TUI: ${PTY_SKIP_REASON}`)
      engineer.kill()
      return
    }
    const tui = await Tui.start(sb, { attached: true })
    await tui.waitForDashboard()
    await tui.waitForText('github__big_report', { timeoutMs: 20_000 })
    await sleep(KEY_SETTLE_MS)
    tui.press('a')
    const res = await reply
    expect(res.error, JSON.stringify(res)).toBeUndefined()
    const decided = await sb.row<{ decision: string; decided_by: string }>(
      'the decided request',
      'SELECT decision, decided_by FROM requests WHERE id = ?',
      pending.request_id,
    )
    expect(decided).toEqual({ decision: 'allowed', decided_by: 'user:tui' })
    ev(`you, in the TUI attached to the service: \`a\` → allowed (decided_by=${decided.decided_by}); the engineer's call returns`)
    await tui.stop()
    await engineer.close()
  })

  await j.step("the day's report: who did what", async (ev) => {
    const report = sb.ok(['org', 'report', 'today'])
    expect(report).toContain('Acme QA')
    // Six tasks, and the three wakes that brought results back up.
    expect(report).toMatch(/Tasks 9 finished/)
    ev(`foreman org report today: "${report.split('\n').slice(0, 3).join(' | ')}"`)
    const activity = await as('hermes', (a) => a.call('submit_command', { command: 'activity', args: ['10'] }))
    expect(replyText(activity)).toContain('write zeroclaw: Review the launch budget')
    expect(replyText(activity)).not.toContain('ago ago')
    ev(`the CEO asks /foreman activity: "${replyText(activity).split('\n').slice(0, 2).join(' | ')}"`)
  })

  await j.step('nothing tried to reach the network; the service stops cleanly', async (ev) => {
    expect(sb.networkAttempts()).toEqual([])
    const svc = service as ChildProcess | null
    if (svc) {
      const exited = new Promise<number | null>((r) => (svc.exitCode !== null ? r(svc.exitCode) : svc.once('exit', (code) => r(code))))
      svc.kill('SIGTERM')
      expect(await exited).toBe(0)
    }
    ev('network guard: 0 non-loopback attempts; SIGTERM → the service exits 0')
  })
})
