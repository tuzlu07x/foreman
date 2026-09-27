import { existsSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import { Journey } from '../support/journey.js'
import { McpAgent, replyText } from '../support/mcp-agent.js'
import { isAlive, processEnv, Sandbox, sleep } from '../support/sandbox.js'
import { KEY_SETTLE_MS, PTY_AVAILABLE, PTY_SKIP_REASON, Tui } from '../support/tui.js'

interface Decision {
  id: string
  decision: string
  decided_by: string
  risk_bucket: string
}

interface PendingRow {
  status: string
  decision: string | null
  resolved_by: string | null
}

let sandbox: Sandbox | null = null
afterEach(async () => {
  await sandbox?.dispose()
  sandbox = null
})

it('Approve and deny from the TUI across processes', async (context) => {
  const j = new Journey(
    context.task,
    'tui-approvals',
    '`foreman start` runs in a real pseudo-terminal. A separate agent process (`foreman mcp-stdio --source claude-code`) makes risky calls; the approval shows up in the TUI and is decided with the `a` and `d` keys.',
  )
  if (!PTY_AVAILABLE) return j.skip(context, PTY_SKIP_REASON)
  const sb = (sandbox = await Sandbox.create('tui-approvals'))
  sb.ok(['init'])

  const tui = await j.step('`foreman start` boots the TUI in a pty', async (ev) => {
    const t = await Tui.start(sb)
    await t.waitForDashboard()
    expect(t.screen()).toMatch(/0\/0 agents/)
    expect(t.screen()).toContain('nothing waiting')
    ev(`foreman start pid ${t.pid} (pidfile written); dashboard header: "0/0 agents", "nothing waiting"`)
    const env = t.pid === null ? {} : processEnv(t.pid)
    expect(env.NODE_OPTIONS).toContain('no-network.cjs')
    expect(env.FOREMAN_HOME).toBe(sb.home)
    ev('the running foreman start has FOREMAN_HOME = the sandbox and the network guard preloaded (/proc/<pid>/environ)')
    return t
  })

  const agent = await McpAgent.connect(sb, 'claude-code', { FOREMAN_APPROVAL_TIMEOUT: '90' })

  /** A risky call from the agent; resolves once the TUI shows it. */
  const riskyCall = async (path: string, ev: (line: string) => void) => {
    const mark = tui.mark()
    const reply = agent.call('read_file', { path }, 120_000)
    const screen = await tui.waitForText(path, { from: mark })
    expect(screen).toContain('read_file')
    expect(screen).toContain('claude-code')
    const pending = await sb.row<PendingRow & { request_id: string; risk_bucket: string }>(
      'a pending approval',
      "SELECT request_id, status, decision, resolved_by, risk_bucket FROM pending_approvals WHERE args LIKE ? AND status = 'pending'",
      `%${path}%`,
    )
    ev(`TUI shows the approval: claude-code → read_file(${path}); pending_approvals ${pending.request_id} is pending (risk ${pending.risk_bucket})`)
    return { reply, requestId: pending.request_id }
  }

  let allowedId = ''
  await j.step('a risky call (read_file config/.env) waits for approval; `a` allows it', async (ev) => {
    const { reply, requestId } = await riskyCall('config/.env', ev)
    allowedId = requestId
    // Letter keys are ignored for a moment after the approval on screen changes.
    await sleep(KEY_SETTLE_MS)
    tui.press('a')
    const res = await reply
    expect(res.error).toBeUndefined()
    expect(replyText(res)).toBe('(foreman) read_file allowed by user:tui')
    ev(`agent reply: "${replyText(res)}"`)
    const row = await sb.row<Decision>('the requests row', 'SELECT id, decision, decided_by, risk_bucket FROM requests WHERE id = ?', requestId)
    expect(row).toMatchObject({ decision: 'allowed', risk_bucket: 'high' })
    expect(row.decided_by).toMatch(/^user(:tui)?$/)
    const pending = await sb.row<PendingRow>('the resolved approval', 'SELECT status, decision, resolved_by FROM pending_approvals WHERE request_id = ?', requestId)
    expect(pending).toEqual({ status: 'resolved', decision: 'allowed', resolved_by: 'user' })
    ev(`requests ${requestId}: allowed, decided_by=${row.decided_by}; pending_approvals: resolved_by=user`)
    const item = await sb.inboxItem('the allowed approval', (i) => i.requestId === requestId && i.title.startsWith('Allowed'))
    expect(item.title).toBe('Allowed read_file for claude-code')
    expect(item.body).toBe('by you in the TUI')
    ev(`foreman inbox --json: "${item.title}" / "${item.body}"`)
  })

  await j.step('a second risky call (read_file backup/.ssh/id_rsa); `d` denies it', async (ev) => {
    const { reply, requestId } = await riskyCall('backup/.ssh/id_rsa', ev)
    await sleep(KEY_SETTLE_MS)
    tui.press('d')
    const res = await reply
    expect(res.error?.message).toBe('Denied by user:tui')
    ev(`agent reply: error "${res.error?.message}"`)
    const row = await sb.row<Decision>('the requests row', 'SELECT id, decision, decided_by, risk_bucket FROM requests WHERE id = ?', requestId)
    expect(row.decision).toBe('denied')
    expect(row.decided_by).toMatch(/^user(:tui)?$/)
    const pending = await sb.row<PendingRow>('the resolved approval', 'SELECT status, decision, resolved_by FROM pending_approvals WHERE request_id = ?', requestId)
    expect(pending).toEqual({ status: 'resolved', decision: 'denied', resolved_by: 'user' })
    ev(`requests ${requestId}: denied, decided_by=${row.decided_by}; pending_approvals: resolved_by=user`)
    const item = await sb.inboxItem('the denied approval', (i) => i.requestId === requestId && i.title.startsWith('Denied'))
    expect(item.title).toBe('Denied read_file for claude-code')
    expect(item.body).toBe('by you in the TUI')
    ev(`foreman inbox --json: "${item.title}" / "${item.body}"`)
    const log = sb.json<Array<{ id: string; decision: string; decidedBy: string }>>(['log', 'tail', '--json', '-n', '5'])
    expect(log.find((r) => r.id === requestId)).toMatchObject({ decision: 'denied', decidedBy: row.decided_by })
    expect(log.find((r) => r.id === allowedId)).toMatchObject({ decision: 'allowed', decidedBy: row.decided_by })
    ev(`foreman log tail --json lists both decisions (allowed, denied) with decidedBy=${row.decided_by}`)
    // #637: the deciding surface travels across processes.
    expect(row.decided_by).toBe('user:tui')
  })

  await j.step('the agent disconnects and `foreman start` shuts down cleanly', async (ev) => {
    expect(await agent.close()).toBe(0)
    const pid = tui.pid
    const code = await tui.stop()
    expect(code).toBe(0)
    expect(existsSync(sb.path('foreman.pid'))).toBe(false)
    expect(pid !== null && isAlive(pid)).toBe(false)
    ev(`SIGTERM → foreman start exited ${code}, pidfile removed, pid ${pid} gone`)
  })

  await j.step('nothing tried to reach the network', (ev) => {
    expect(sb.networkAttempts()).toEqual([])
    ev('network guard: 0 non-loopback connection attempts')
  })
})
