import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'
import { afterEach, expect, it } from 'vitest'
import { FakeOllama, questionOf } from '../support/fake-ollama.js'
import { FakeSlack, type SlackMessage } from '../support/fake-slack.js'
import { Journey } from '../support/journey.js'
import { McpAgent, replyText } from '../support/mcp-agent.js'
import { FOREMAN_BIN, Sandbox, sleep, waitFor } from '../support/sandbox.js'

// =============================================================================
// Chat that hands out work: "analyse this repo as a team" from Slack
// =============================================================================
//
// The boss asks Foreman in plain words. Foreman's LLM (a fake Ollama on
// 127.0.0.1) knows the org chart and proposes who does what; one approval
// in Slack hands the plan out as the boss's own `assign`s, and the stand-in
// agents get the work. A denied plan starts nothing. The chat remembers the
// conversation. The background service (`foreman daemon --service`) runs the
// gateway, so no pseudo-terminal is needed.

const AGENT_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'support', 'company-agent.cjs')

const BOT_TOKEN = 'xoxb-qa-fake-bot-token'
const APP_TOKEN = 'xapp-qa-fake-app-token'
/** The boss: allowed, and the only owner. */
const BOSS = 'U0BOSS'
const ALERTS = '#foreman'
const MODEL = 'qa-llama'

const ORG = `# Acme QA: a manager on Claude Code, IT led by a Codex instance
version: 1
company: "Acme QA"
human:
  title: Founder
delegation:
  cross_department: via_heads
  skip_levels: true
departments:
  it:
    name: IT
    head: backend-developer
roles:
  manager:
    title: Engineering Manager
    agent: claude-code
    reports_to: human
    responsibility: cost and time estimates
  backend-developer:
    title: Backend Developer
    agent: backend
    department: it
    reports_to: manager
    responsibility: the API
`

/** What the stand-ins do with the plan's tasks. */
const PLAYBOOK = {
  codex: [{ when: 'Analyse github\\.com/acme/api', reply: 'Analysed github.com/acme/api: 3 services, 12 to-dos, QA steps written; report sent to the manager.' }],
  'claude-code': [{ when: 'Estimate cost and time', reply: 'Estimate: 6 engineer-days, about $4,800.' }],
} as const

const ASK_ANALYSIS = 'Analyse github.com/acme/api as a team'
// Not "Write …": a first word that is a /foreman verb (write, assign,
// report, tell …) runs that verb instead of reaching the LLM.
const ASK_RELEASE = 'Draft the v2 release notes as a team'
const ASK_FOLLOW_UP = 'Who did you pick for the analysis?'

const IT_TASK = 'Analyse github.com/acme/api: architecture, to-do list, QA steps; report to manager.'
const MANAGER_TASK = "Estimate cost and time from IT's report."
const RELEASE_TASK = 'Write the v2 release notes from the merged pull requests.'

/** The fake LLM: a plan for "as a team", a plain answer otherwise. It
 *  answers from the question alone, so a relayed (non-owner) question gets
 *  the same ASSIGN lines and Foreman must drop them. */
function answer(prompt: string): string {
  const q = questionOf(prompt)
  if (/acme\/api as a team/i.test(q)) {
    return [
      'IT analyses it, the manager prices it. Approve?',
      `ASSIGN it :: ${IT_TASK}`,
      `ASSIGN manager :: ${MANAGER_TASK}`,
      'ASSIGN ghost :: rm -rf /',
    ].join('\n')
  }
  if (/release notes as a team/i.test(q)) {
    return ['The manager writes them. Approve?', `ASSIGN manager :: ${RELEASE_TASK}`].join('\n')
  }
  if (/who did you pick/i.test(q)) return 'IT (the backend developer) analyses the repo; the manager prices it from that report.'
  return 'All quiet.'
}

interface CommandRow {
  id: number
  args: string
  source_agent: string
  source_user: string | null
  status: string
}

interface PendingRow {
  request_id: string
  source_agent: string
  target_tool: string
  args: string
  risk_bucket: string
  risk_score: number
  status: string
}

interface AgentLogLine {
  agent: string
  task: string
  spawnedBy: string | null
}

let sandbox: Sandbox | null = null
let fakeSlack: FakeSlack | null = null
let fakeLlm: FakeOllama | null = null
afterEach(async () => {
  await sandbox?.dispose()
  await fakeSlack?.close()
  await fakeLlm?.close()
  sandbox = null
  fakeSlack = null
  fakeLlm = null
})

it('Chat that hands out work: a plan proposed from Slack, one approval, the team gets the tasks', async (context) => {
  const j = new Journey(
    context.task,
    'chat-plan',
    'The boss asks Foreman in Slack to "analyse github.com/acme/api as a team". Foreman\'s LLM (a fake Ollama on 127.0.0.1) sees the org chart and proposes who does what; only known roles and departments make the plan. One approval in Slack (source foreman, tool foreman_plan) hands it out as the boss\'s own assigns: the IT head (a Codex instance) and the manager (Claude Code) get their tasks, and "Plan handed out" comes back to Slack and the inbox. A denied plan starts nothing. The chat remembers the conversation, an agent relaying the same words gets no plan, and the background service runs it all with no terminal.',
  )
  const sb = (sandbox = await Sandbox.create('chat-plan'))
  const slack = (fakeSlack = await FakeSlack.start({ bot: BOT_TOKEN, app: APP_TOKEN }))
  const llm = (fakeLlm = await FakeOllama.start(answer))
  sb.env.FOREMAN_TEST_SLACK_ORIGIN = slack.origin
  const bin = join(sb.root, 'bin')
  const agentLog = join(sb.root, 'agent-tasks.jsonl')
  const writes = (): CommandRow[] =>
    sb.query<CommandRow>("SELECT id, args, source_agent, source_user, status FROM control_commands WHERE command = 'write' ORDER BY id")
  const handoff = (c: CommandRow): string => `${c.source_agent}/${c.source_user} → ${JSON.parse(c.args)[0]}: ${JSON.parse(c.args)[1]}`
  const tasks = (): AgentLogLine[] =>
    existsSync(agentLog) ? readFileSync(agentLog, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as AgentLogLine) : []
  const oneLine = (s: string): string => s.replace(/\n+/g, ' | ')

  await j.step('the org: a manager (Claude Code) reporting to you, IT led by backend-developer (a Codex instance)', (ev) => {
    const exe = (name: string, body: string): void => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(join(bin, name), 0o755)
    }
    exe('foreman', `exec "${process.execPath}" "${FOREMAN_BIN}" "$@"`)
    exe('codex', `exec node "${AGENT_JS}" codex task "$@"`)
    exe('claude', `exec node "${AGENT_JS}" claude-code task "$@"`)
    sb.ok(['init'])
    sb.ok(['agent', 'add', 'codex'])
    sb.ok(['agent', 'add', 'claude-code'])
    expect(sb.ok(['agent', 'add', 'backend', '--type', 'codex'])).toContain('backend runs as its own')
    sb.write('org.yaml', ORG)
    const validate = sb.run(['org', 'validate'])
    expect(validate.status, validate.stdout + validate.stderr).toBe(0)
    const show = sb.ok(['org', 'show'])
    expect(show).toMatch(/manager\b.*claude-code/)
    expect(show).toMatch(/backend-developer\b.*backend/)
    writeFileSync(join(sb.root, 'playbook.json'), JSON.stringify(PLAYBOOK, null, 2))
    sb.env.QA_PLAYBOOK = join(sb.root, 'playbook.json')
    sb.env.QA_AGENT_LOG = agentLog
    ev('agent add claude-code, codex; agent add backend --type codex ("backend runs as its own …"); stand-ins on PATH (qa/support/company-agent.cjs)')
    ev('org.yaml: manager = claude-code (reports to human); department it, head backend-developer = backend (reports to manager); org validate exits 0')
  })

  await j.step("Foreman's LLM is a fake Ollama on 127.0.0.1, and two-way Slack is on for the boss (the only owner)", async (ev) => {
    sb.write(
      'llm.yaml',
      [
        'enabled: true',
        'provider: ollama',
        `model: ${MODEL}`,
        'features:',
        '  orchestrator_chat: true',
        'credentials:',
        '  ollama:',
        `    endpoint: ${llm.origin}`,
        '',
      ].join('\n'),
    )
    sb.ok(['secrets', 'add', 'slack-bot-token'], { input: `${BOT_TOKEN}\n` })
    sb.ok(['secrets', 'add', 'slack-app-token'], { input: `${APP_TOKEN}\n` })
    sb.ok(['notify', 'enable', 'slack', '--channel', ALERTS])
    expect(await sb.okAsync(['notify', 'slack-interactive', '--user', BOSS])).toContain(`two-way Slack is on for ${BOSS}`)
    const path = sb.path('notify.yaml')
    const doc = parseDocument(readFileSync(path, 'utf-8'))
    doc.setIn(['channels', 'slack', 'owner_user_ids'], [BOSS])
    writeFileSync(path, doc.toString())
    // A plan is a medium-risk approval (warning level); route it to Slack.
    expect(sb.ok(['notify', 'route', 'critical', 'slack'])).toContain('critical → slack')
    expect(sb.ok(['notify', 'route', 'warning', 'slack'])).toContain('warning → slack')
    expect(sb.read('notify.yaml')).not.toContain(BOT_TOKEN)
    ev(`llm.yaml: enabled, provider ollama, model ${MODEL}, features.orchestrator_chat, credentials.ollama.endpoint ${llm.origin}`)
    ev(`notify enable slack --channel ${ALERTS}; notify slack-interactive --user ${BOSS}; owner_user_ids [${BOSS}]; routes critical, warning → slack`)
  })

  let service: ChildProcess | null = null
  await j.step('the background service runs the gateway and opens Socket Mode on the fake Slack', async (ev) => {
    let log = ''
    const child = spawn(process.execPath, [FOREMAN_BIN, 'daemon', '--service'], { cwd: sb.cwd, env: { ...sb.env, NO_COLOR: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr!.setEncoding('utf-8').on('data', (c: string) => (log += c))
    sb.onDispose(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((r) => child.once('exit', r))
        child.kill('SIGKILL')
        await exited
      }
    })
    service = child
    await waitFor('the service daemon to listen', () => log.includes('daemon: listening on'), { timeoutMs: 30_000 })
    await slack.connected()
    ev(`foreman daemon --service (pid ${child.pid}); apps.connections.open with the app token; Socket Mode connected`)
  })

  /** `/foreman <text>` from the boss; the reply on its response_url. */
  const ask = async (text: string): Promise<string> => {
    const cmd = slack.slash(BOSS, text)
    await slack.acked(cmd.envelopeId)
    const reply = await slack.hook(`the reply to "${text}"`, cmd.path, 30_000)
    return String(reply.body.text ?? '')
  }
  const approvalFor = (needle: string): Promise<SlackMessage> =>
    slack.message(`the plan approval (${needle})`, (m) => m.channel === ALERTS && JSON.stringify(m.body).includes('foreman_allow') && JSON.stringify(m.body).includes(needle))
  const pendingPlan = (needle: string): Promise<PendingRow> =>
    sb.row<PendingRow>(
      'the pending plan approval',
      "SELECT request_id, source_agent, target_tool, args, risk_bucket, risk_score, status FROM pending_approvals WHERE target_tool = 'foreman_plan' AND args LIKE ?",
      `%${needle}%`,
    )

  let firstPrompt = ''
  let planMessage: SlackMessage | null = null
  let planRequestId = ''
  await j.step('the boss asks in plain words; Foreman answers with a numbered plan (known roles only) and asks for approval', async (ev) => {
    const text = await ask(ASK_ANALYSIS)
    expect(text).toContain('IT analyses it, the manager prices it.')
    expect(text).toContain(`1. it: ${IT_TASK}`)
    expect(text).toContain(`2. manager: ${MANAGER_TASK}`)
    expect(text).not.toContain('ghost')
    expect(text).not.toContain('rm -rf')
    expect(text).not.toContain('ASSIGN')
    expect(text).toContain("I've sent this plan for your approval. Tap Allow and I'll hand it out; nothing starts before that.")
    ev(`${BOSS} /foreman ${ASK_ANALYSIS} → "${oneLine(text)}"`)
    const call = await llm.call('the analysis question', (q) => q === ASK_ANALYSIS)
    firstPrompt = call.prompt
    expect(call).toMatchObject({ path: '/v1/chat/completions', model: MODEL })
    expect(call.prompt).toContain('ASSIGN <role or department id> :: <task>')
    expect(call.prompt).toContain('Department it "IT", head: backend-developer')
    expect(call.prompt).toMatch(/Role manager "Engineering Manager" \(runs on Claude Code, reports to human\)/)
    expect(call.prompt).toMatch(/Role backend-developer "Backend Developer" \(runs on Codex, in it, reports to manager\)/)
    expect(call.prompt).not.toContain('Conversation so far:')
    ev(`fake Ollama: POST ${call.path} model=${call.model}; the prompt has the org chart ("Department it \\"IT\\", head: backend-developer", "Role manager …"), the ASSIGN rule, no earlier conversation`)
    ev(`the LLM also answered "ASSIGN ghost :: rm -rf /": not a role or department, dropped from the plan and the reply`)
    expect(writes()).toEqual([])
    ev('control_commands: no write rows yet (nothing is handed out before an Allow)')
  })

  await j.step('the approval is in Slack with Allow / Deny: foreman wants to hand out a plan; audit: source foreman, tool foreman_plan, pending', async (ev) => {
    const pending = await pendingPlan('it: Analyse github.com/acme/api')
    expect(pending).toMatchObject({ source_agent: 'foreman', target_tool: 'foreman_plan', status: 'pending', risk_bucket: 'medium' })
    const args = JSON.parse(pending.args) as { plan: string[] }
    expect(args.plan).toEqual([`it: ${IT_TASK}`, `manager: ${MANAGER_TASK}`])
    ev(`pending_approvals ${pending.request_id}: source_agent=${pending.source_agent}, target_tool=${pending.target_tool}, risk ${pending.risk_score} (${pending.risk_bucket}), status=${pending.status}; args.plan = ${JSON.stringify(args.plan)}`)
    const message = await approvalFor('Analyse github.com/acme/api')
    const body = JSON.stringify(message.body)
    expect(body).toContain('foreman wants to hand out a plan to your team')
    expect(body).toContain('foreman_deny')
    expect(body).toContain(`Estimate cost and time from IT`)
    ev(`chat.postMessage ${ALERTS}: "${message.text.split('\n')[0]}"; buttons foreman_allow, foreman_deny; the plan is in the args`)
    expect(sb.query<{ n: number }>("SELECT count(*) AS n FROM requests WHERE target_tool = 'foreman_plan'")[0]?.n).toBe(0)
    ev('requests: no foreman_plan row yet (it is written when decided)')
    planMessage = message
    planRequestId = pending.request_id
  })

  await j.step('the boss taps Allow: two assigns land as the boss, the agents get their tasks, "Plan handed out" reaches Slack and the inbox', async (ev) => {
    const tap = slack.tap(BOSS, planMessage!, 'foreman_allow')
    await slack.acked(tap.envelopeId)
    const outcome = await slack.hook('the outcome', tap.path)
    expect(outcome.body).toMatchObject({ replace_original: true, text: `Allowed ✓ by <@${BOSS}>` })
    const decided = await sb.row<{ decision: string; decided_by: string; source_agent: string }>(
      'the requests row',
      'SELECT decision, decided_by, source_agent FROM requests WHERE id = ?',
      planRequestId,
    )
    expect(decided).toEqual({ decision: 'allowed', decided_by: `user:slack:${BOSS}`, source_agent: 'foreman' })
    ev(`${BOSS} taps Allow → response_url "${String(outcome.body.text)}"; requests ${planRequestId}: allowed, decided_by=${decided.decided_by}`)

    const rows = await waitFor(
      'two hand-offs to finish',
      () => {
        const done = writes().filter((c) => c.status !== 'pending')
        return done.length >= 2 ? done : null
      },
      { timeoutMs: 90_000, intervalMs: 300 },
    )
    expect(rows.map(handoff).sort()).toEqual(
      [`slack/slack:${BOSS} → backend: ${IT_TASK}`, `slack/slack:${BOSS} → claude-code: ${MANAGER_TASK}`].sort(),
    )
    expect(rows.every((r) => r.status === 'applied'), JSON.stringify(rows)).toBe(true)
    for (const r of rows) ev(`control_commands #${r.id} write ${handoff(r)} → ${r.status}`)
    const assigns = sb
      .events<{ command: string; args: string[]; sourceAgent: string; sourceUser: string | null; ok: boolean; via?: string; requestId?: string }>('foreman:command')
      .filter((e) => e.command === 'assign')
    expect(assigns.map(({ args, sourceAgent, sourceUser, ok, via, requestId }) => ({ args, sourceAgent, sourceUser, ok, via, requestId }))).toEqual([
      { args: ['it', IT_TASK], sourceAgent: 'slack', sourceUser: `slack:${BOSS}`, ok: true, via: 'foreman_plan', requestId: planRequestId },
      { args: ['manager', MANAGER_TASK], sourceAgent: 'slack', sourceUser: `slack:${BOSS}`, ok: true, via: 'foreman_plan', requestId: planRequestId },
    ])
    ev(`audit_events foreman:command: assign it / assign manager from slack:${BOSS}, ok, via foreman_plan, requestId ${planRequestId}`)

    const it = await waitFor('the IT task at the Codex instance', () => tasks().find((t) => t.task.includes(IT_TASK)), { timeoutMs: 30_000 })
    expect(it).toMatchObject({ agent: 'codex', spawnedBy: 'backend' })
    expect(it.task).toContain('You are Backend Developer (role "backend-developer" in IT) at Acme QA')
    const mgr = await waitFor('the manager task at Claude Code', () => tasks().find((t) => t.task.includes(MANAGER_TASK)), { timeoutMs: 30_000 })
    expect(mgr).toMatchObject({ agent: 'claude-code', spawnedBy: 'claude-code' })
    expect(tasks().some((t) => t.task.includes('rm -rf'))).toBe(false)
    ev(`agent task log: codex as backend got "…${IT_TASK}"; claude-code got "…${MANAGER_TASK}"; nobody got the ghost task`)

    const done = await slack.message('"Plan handed out"', (m) => m.text.includes('Plan handed out'), 30_000)
    expect(done.text).toMatch(/✓ it: /)
    expect(done.text).toMatch(/✓ manager: /)
    expect(done.text).not.toContain('✗')
    ev(`chat.postMessage ${done.channel}: "${oneLine(done.text)}"`)
    const item = await sb.inboxItem('"Plan handed out"', (i) => i.title === 'Plan handed out (from slack)')
    expect(item.body).toMatch(/✓ it: [\s\S]*✓ manager: /)
    ev(`inbox: "${item.title}" / "${oneLine(item.body)}"`)
  })

  await j.step('a second plan, denied: "Plan not started" reaches Slack and nothing new is handed out', async (ev) => {
    const text = await ask(ASK_RELEASE)
    expect(text).toContain(`1. manager: ${RELEASE_TASK}`)
    expect(text).toContain("I've sent this plan for your approval.")
    ev(`${BOSS} /foreman ${ASK_RELEASE} → "${oneLine(text)}"`)
    const pending = await pendingPlan('v2 release notes')
    const message = await approvalFor('v2 release notes')
    const tap = slack.tap(BOSS, message, 'foreman_deny')
    await slack.acked(tap.envelopeId)
    const outcome = await slack.hook('the deny outcome', tap.path)
    expect(outcome.body).toMatchObject({ replace_original: true, text: `Denied ✗ by <@${BOSS}>` })
    const decided = await sb.row<{ decision: string; decided_by: string }>('the requests row', 'SELECT decision, decided_by FROM requests WHERE id = ?', pending.request_id)
    expect(decided).toEqual({ decision: 'denied', decided_by: `user:slack:${BOSS}` })
    ev(`approval ${pending.request_id} in ${ALERTS}; ${BOSS} taps Deny → "${String(outcome.body.text)}"; requests: denied by ${decided.decided_by}`)
    const notStarted = await slack.message('"Plan not started"', (m) => m.text.includes('Plan not started'), 30_000)
    expect(notStarted.text).toContain('Nobody allowed it (denied or timed out).')
    ev(`chat.postMessage ${notStarted.channel}: "${oneLine(notStarted.text)}"`)
    await sb.inboxItem('"Plan not started"', (i) => i.title === 'Plan not started (from slack)')
    // Give a wrongly started hand-off time to show up.
    await sleep(2_000)
    expect(writes()).toHaveLength(2)
    expect(tasks().some((t) => t.task.includes(RELEASE_TASK))).toBe(false)
    ev('inbox: "Plan not started (from slack)"; control_commands still has the 2 writes; no agent got the release-notes task')
  })

  await j.step('memory: a follow-up question carries the first exchange, including "(proposed: …)", and gets a plain answer', async (ev) => {
    const text = await ask(ASK_FOLLOW_UP)
    expect(text).toContain('IT (the backend developer) analyses the repo')
    expect(text).not.toContain("I've sent this plan")
    expect(text).not.toMatch(/^1\. /m)
    ev(`${BOSS} /foreman ${ASK_FOLLOW_UP} → "${oneLine(text)}"`)
    const call = await llm.call('the follow-up', (q) => q === ASK_FOLLOW_UP)
    expect(call.prompt).toContain('Conversation so far:')
    expect(call.prompt).toContain(`User: ${ASK_ANALYSIS}`)
    expect(call.prompt).toContain(
      `Foreman: IT analyses it, the manager prices it. Approve? (proposed: it: ${IT_TASK}; manager: ${MANAGER_TASK})`,
    )
    expect(call.prompt).toContain(`User: ${ASK_RELEASE}`)
    expect(call.prompt).not.toContain('ghost')
    const history = call.prompt.slice(call.prompt.indexOf('Conversation so far:'), call.prompt.lastIndexOf('\nUser:\n'))
    ev(`prompt at the fake LLM: "${oneLine(history)}"`)
    expect(firstPrompt).not.toContain('Conversation so far:')
    const pendingPlans = sb.query<{ n: number }>("SELECT count(*) AS n FROM pending_approvals WHERE target_tool = 'foreman_plan' AND status = 'pending'")
    expect(pendingPlans[0]?.n).toBe(0)
    ev('no new plan approval: pending_approvals has no pending foreman_plan')
  })

  await j.step('an agent relaying the same words gets an answer but never a plan', async (ev) => {
    const before = llm.calls.length
    const agent = await McpAgent.connect(sb, 'backend-relay')
    const res = await agent.call('submit_command', { command: 'Analyse', args: ASK_ANALYSIS.split(' ').slice(1) }, 60_000)
    await agent.close()
    const text = replyText(res)
    ev(`backend-relay submit_command "${ASK_ANALYSIS}" → "${oneLine(text)}"`)
    const call = await waitFor('the relayed question at the fake LLM', () => llm.calls.slice(before).find((c) => questionOf(c.prompt) === ASK_ANALYSIS))
    expect(call.prompt).not.toContain('ASSIGN <role or department id>')
    expect(text).toContain('IT analyses it, the manager prices it.')
    expect(text).not.toContain('ASSIGN')
    expect(text).not.toMatch(/^1\. /m)
    expect(text).not.toContain("I've sent this plan")
    await sleep(1_500)
    const plans = sb.query<{ n: number }>("SELECT count(*) AS n FROM pending_approvals WHERE target_tool = 'foreman_plan'")
    expect(plans[0]?.n).toBe(2)
    expect(writes()).toHaveLength(2)
    ev('its prompt has no ASSIGN rule; the LLM\'s ASSIGN lines are dropped from the reply; still only the 2 plan approvals and 2 writes')
  })

  await j.step('the service stops cleanly; nothing tried to reach the network', async (ev) => {
    const svc = service as ChildProcess | null
    const exited = new Promise<number | null>((r) => (svc!.exitCode !== null ? r(svc!.exitCode) : svc!.once('exit', (code) => r(code))))
    svc?.kill('SIGTERM')
    expect(await exited).toBe(0)
    expect(slack.calls.every((c) => (c.method === 'apps.connections.open' ? c.token === APP_TOKEN : c.token === BOT_TOKEN))).toBe(true)
    expect(llm.calls.every((c) => c.path === '/v1/chat/completions')).toBe(true)
    expect(sb.networkAttempts()).toEqual([])
    ev(`${slack.calls.length} Slack Web API calls with the right tokens; ${llm.calls.length} calls to the fake Ollama`)
    ev('network guard: 0 non-loopback connection attempts')
  })
})
