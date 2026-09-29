import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import { FakeSlack, type SlackMessage } from '../support/fake-slack.js'
import { Journey } from '../support/journey.js'
import { agentToken, McpAgent, replyText } from '../support/mcp-agent.js'
import { FOREMAN_BIN, isAlive, Sandbox, sleep, waitFor } from '../support/sandbox.js'
import { KEY_SETTLE_MS, PTY_AVAILABLE, PTY_SKIP_REASON, Tui } from '../support/tui.js'

// =============================================================================
// Approvals with the TUI closed: the background service's headless gateway
// =============================================================================
//
// `foreman service install` runs `foreman daemon --service` at login. The
// scenario runs that command itself (installing a LaunchAgent or a systemd
// unit would reach outside the sandbox), against a fake Slack on 127.0.0.1.

interface Decision {
  decision: string
  decided_by: string
}

interface DoctorCheck {
  name: string
  status: string
  message: string
}

const BOT_TOKEN = 'xoxb-qa-fake-bot-token'
const APP_TOKEN = 'xapp-qa-fake-app-token'
const BOSS = 'U0BOSS'
const ALERTS = '#foreman'
const AGENT = 'it-lead'

let sandbox: Sandbox | null = null
let fakeSlack: FakeSlack | null = null
afterEach(async () => {
  await sandbox?.dispose()
  await fakeSlack?.close()
  sandbox = null
  fakeSlack = null
})

it('Approvals reach Slack with no terminal open, and `foreman start` attaches to the service', async (context) => {
  const j = new Journey(
    context.task,
    'headless-gateway',
    'The background service (`foreman daemon --service`) runs the whole gateway with no TUI: a stand-in agent\'s risky call reaches a fake Slack on 127.0.0.1 and the boss decides it with a button. `foreman start` then attaches to the service in a real pseudo-terminal (TUI only), decides a call there, and the Slack message is edited once. Quitting the TUI leaves the service running; SIGTERM stops it cleanly.',
  )
  const sb = (sandbox = await Sandbox.create('headless'))
  const slack = (fakeSlack = await FakeSlack.start({ bot: BOT_TOKEN, app: APP_TOKEN }))
  sb.env.FOREMAN_TEST_SLACK_ORIGIN = slack.origin
  sb.ok(['init'])

  await j.step('two-way Slack for the boss, approvals routed to it, a stand-in agent registered', async (ev) => {
    sb.ok(['secrets', 'add', 'slack-bot-token'], { input: `${BOT_TOKEN}\n` })
    sb.ok(['secrets', 'add', 'slack-app-token'], { input: `${APP_TOKEN}\n` })
    sb.ok(['notify', 'enable', 'slack', '--channel', ALERTS])
    expect(await sb.okAsync(['notify', 'slack-interactive', '--user', BOSS])).toContain(`two-way Slack is on for ${BOSS}`)
    expect(sb.ok(['notify', 'route', 'critical', 'slack'])).toContain('critical → slack')
    agentToken(sb, AGENT)
    const gateway = sb.json<{ checks: DoctorCheck[] }>(['doctor', '--json'], { allowExit: [0, 1] }).checks.find((c) => c.name === 'gateway')
    expect(gateway).toMatchObject({ status: 'ok', message: expect.stringContaining('slack get approvals only while') })
    ev(`notify enable slack --channel ${ALERTS}; notify slack-interactive --user ${BOSS}; notify route critical slack; agent add ${AGENT}`)
    ev(`foreman doctor --json, gateway: "${gateway?.message}"`)
  })

  let serviceLog = ''
  const service: ChildProcess = await j.step('the service command starts the headless gateway: daemon, Socket Mode, pidfile', async (ev) => {
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
    await waitFor('the service daemon to listen', () => serviceLog.includes('daemon: listening on'), { timeoutMs: 30_000 })
    await slack.connected()
    const pidfile = readFileSync(sb.path('foreman.pid'), 'utf-8')
    expect(pidfile).toBe(`${child.pid}\nheadless\n`)
    const status = sb.ok(['service', 'status'])
    expect(status).toContain(`gateway    the background service (pid ${child.pid})`)
    const gateway = sb.json<{ checks: DoctorCheck[] }>(['doctor', '--json'], { allowExit: [0, 1] }).checks.find((c) => c.name === 'gateway')
    expect(gateway).toEqual({
      name: 'gateway',
      status: 'ok',
      message: `the background service (pid ${child.pid}) — approvals go to slack; decide from slack`,
    })
    ev(`foreman daemon --service (pid ${child.pid}): "${serviceLog.split('\n').find((l) => l.includes('listening on'))?.trim()}"`)
    ev(`apps.connections.open with the app token; Socket Mode connected. foreman.pid: ${JSON.stringify(pidfile)}`)
    ev(`foreman service status: "${status.split('\n').find((l) => l.includes('gateway'))?.trim()}"`)
    ev(`foreman doctor --json, gateway: "${gateway?.message}"`)
    return child
  })

  const approvalIn = (path: string) =>
    slack.message(`the approval for ${path}`, (m) => m.channel === ALERTS && m.text.includes(path) && JSON.stringify(m.body.blocks ?? []).includes('foreman_allow'))
  const pendingFor = (path: string) =>
    sb.row<{ request_id: string }>('the pending approval', "SELECT request_id FROM pending_approvals WHERE args LIKE ? AND status = 'pending'", `%${path}%`)

  await j.step('no TUI anywhere: a risky call reaches Slack, and the boss allows it with a button', async (ev) => {
    const agent = await McpAgent.connect(sb, AGENT, { FOREMAN_APPROVAL_TIMEOUT: '90' })
    const reply = agent.call('read_file', { path: 'ops/.env' }, 90_000)
    const { request_id: requestId } = await pendingFor('ops/.env')
    const message = await approvalIn('ops/.env')
    ev(`${AGENT} read_file(ops/.env) → pending ${requestId} → chat.postMessage ${ALERTS}: "${message.text.split('\n')[0]}"`)
    const tap = slack.tap(BOSS, message, 'foreman_allow')
    await slack.acked(tap.envelopeId)
    const res = await reply
    expect(res.error).toBeUndefined()
    const outcome = await slack.hook('the outcome', tap.path)
    expect(outcome.body).toMatchObject({ replace_original: true, text: `Allowed ✓ by <@${BOSS}>` })
    const row = await sb.row<Decision>('the requests row', 'SELECT decision, decided_by FROM requests WHERE id = ?', requestId)
    expect(row).toEqual({ decision: 'allowed', decided_by: `user:slack:${BOSS}` })
    await agent.close()
    ev(`${BOSS} taps Allow; agent reply "${replyText(res)}"; response_url: "${String(outcome.body.text)}"`)
    ev(`requests ${requestId}: allowed, decided_by=${row.decided_by}`)
  })

  if (!PTY_AVAILABLE) {
    j.note(`Skipped attaching \`foreman start\` to the service: ${PTY_SKIP_REASON}`)
  } else {
    const tui = await j.step('`foreman start` attaches to the service: TUI only', async (ev) => {
      const opens = slack.calls.filter((c) => c.method === 'apps.connections.open').length
      const t = await Tui.start(sb, { attached: true })
      await t.waitForDashboard()
      expect(t.pid).not.toBeNull()
      expect(t.pid).not.toBe(service.pid)
      // The service still holds the home, and nothing opened a second Socket Mode connection.
      expect(readFileSync(sb.path('foreman.pid'), 'utf-8')).toBe(`${service.pid}\nheadless\n`)
      await sleep(2_000)
      expect(slack.calls.filter((c) => c.method === 'apps.connections.open')).toHaveLength(opens)
      ev(`the header says "attached"; foreman.pid is still the service's (pid ${service.pid}); no second apps.connections.open`)
      return t
    })

    await j.step('decided in the attached TUI: the agent gets it, and the Slack message is edited once', async (ev) => {
      const agent = await McpAgent.connect(sb, AGENT, { FOREMAN_APPROVAL_TIMEOUT: '90' })
      const mark = tui.mark()
      const reply = agent.call('read_file', { path: 'config/.env' }, 90_000)
      await tui.waitForText('config/.env', { from: mark })
      const { request_id: requestId } = await pendingFor('config/.env')
      const message: SlackMessage = await approvalIn('config/.env')
      ev(`${AGENT} read_file(config/.env) → pending ${requestId}: in the TUI and in ${ALERTS} ("${message.text.split('\n')[0]}")`)
      await sleep(KEY_SETTLE_MS)
      const asked = tui.mark()
      tui.press('a')
      await tui.waitForText('Allow this HIGH-risk call', { from: asked })
      tui.press('y')
      const res = await reply
      expect(res.error).toBeUndefined()
      expect(replyText(res)).toBe('(foreman) read_file allowed by user:tui')
      const row = await sb.row<Decision>('the requests row', 'SELECT decision, decided_by FROM requests WHERE id = ?', requestId)
      expect(row).toEqual({ decision: 'allowed', decided_by: 'user:tui' })
      const edits = () => slack.calls.filter((c) => c.method === 'chat.update' && c.body.ts === message.ts)
      await waitFor('the Slack message edited', () => edits().length > 0 || null)
      await sleep(2_000)
      expect(edits()).toHaveLength(1)
      expect(JSON.stringify(edits()[0]!.body.blocks)).not.toContain('foreman_allow')
      const posts = slack.calls.filter((c) => c.method === 'chat.postMessage' && JSON.stringify(c.body).includes('config/.env'))
      expect(posts).toHaveLength(1)
      await agent.close()
      ev(`\`a\`, \`y\` in the TUI; agent reply "${replyText(res)}"; requests: allowed, decided_by=${row.decided_by}`)
      ev(`Slack: 1 chat.postMessage and 1 chat.update for ${message.ts} (buttons replaced) — sent once, by the service`)
    })

    await j.step('quitting the attached TUI leaves the service running', async (ev) => {
      await tui.stop()
      await sleep(1_000)
      expect(service.exitCode).toBeNull()
      expect(isAlive(service.pid!)).toBe(true)
      expect(readFileSync(sb.path('foreman.pid'), 'utf-8')).toBe(`${service.pid}\nheadless\n`)
      expect(existsSync(sb.path('foreman.sock'))).toBe(true)
      ev(`the TUI exited; the service (pid ${service.pid}) still runs, holds foreman.pid and foreman.sock`)
    })
  }

  await j.step('SIGTERM stops the service cleanly: exit 0, pidfile and socket gone', async (ev) => {
    const exited = new Promise<number | null>((r) => (service.exitCode !== null ? r(service.exitCode) : service.once('exit', (code) => r(code))))
    service.kill('SIGTERM')
    expect(await exited).toBe(0)
    expect(existsSync(sb.path('foreman.pid'))).toBe(false)
    expect(existsSync(sb.path('foreman.sock'))).toBe(false)
    ev('exit 0; foreman.pid and foreman.sock removed')
  })

  await j.step('nothing tried to reach the network', (ev) => {
    expect(sb.networkAttempts()).toEqual([])
    ev('network guard: 0 non-loopback connection attempts')
  })
})
