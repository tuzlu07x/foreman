import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { parseDocument } from 'yaml'
import { afterEach, expect, it } from 'vitest'
import { Journey } from '../support/journey.js'
import { McpAgent } from '../support/mcp-agent.js'
import { Sandbox } from '../support/sandbox.js'
import { PTY_AVAILABLE, PTY_SKIP_REASON, Tui } from '../support/tui.js'
import { verifySignature, WebhookReceiver } from '../support/webhook.js'

interface NotificationRow {
  id: string
  request_id: string | null
  level: string
  channel: string
  status: string
}

let sandbox: Sandbox | null = null
let receiver: WebhookReceiver | null = null
afterEach(async () => {
  await sandbox?.dispose()
  await receiver?.close()
  sandbox = null
  receiver = null
})

it('Notifications: signed webhook for a critical approval, outcome in the inbox', async (context) => {
  const j = new Journey(
    context.task,
    'notifications',
    'A `webhook` channel pointing at a local receiver on 127.0.0.1, signed with a secret and routed for `critical`. While `foreman start` runs, a risky agent call must reach the receiver as a signed approval notification, and the TUI inbox must record the approval and how it ended.',
  )
  if (!PTY_AVAILABLE) return j.skip(context, PTY_SKIP_REASON)
  const sb = (sandbox = await Sandbox.create('notifications'))
  const secret = `qa-${randomBytes(16).toString('hex')}`
  const hook = (receiver = await WebhookReceiver.start(secret))
  sb.ok(['init'])

  await j.step('configure the webhook: URL and signing secret in the secret store, routed for critical', (ev) => {
    sb.ok(['secrets', 'add', 'webhook-url'], { input: `${hook.url}\n` })
    sb.ok(['secrets', 'add', 'webhook-secret'], { input: `${secret}\n` })
    sb.ok(['notify', 'enable', 'webhook'])
    const path = sb.path('notify.yaml')
    const doc = parseDocument(readFileSync(path, 'utf-8'))
    doc.setIn(['channels', 'webhook', 'webhook_url_ref'], 'webhook-url')
    doc.setIn(['channels', 'webhook', 'signing_secret_ref'], 'webhook-secret')
    writeFileSync(path, doc.toString())
    expect(sb.ok(['notify', 'route', 'critical', 'webhook'])).toContain('critical → webhook')
    const status = sb.ok(['notify', 'status'])
    expect(status).toMatch(/webhook/)
    const yaml = sb.read('notify.yaml')
    expect(yaml).not.toContain(secret)
    expect(yaml).not.toContain(hook.url)
    ev(`receiver ${hook.url}; secrets webhook-url + webhook-secret stored encrypted (neither value appears in notify.yaml)`)
    ev('`foreman notify enable webhook`, `foreman notify route critical webhook`; `foreman notify status` lists webhook')
  })

  await j.step('`foreman notify test webhook` delivers a signed test message', async (ev) => {
    const out = await sb.okAsync(['notify', 'test', 'webhook'])
    expect(out).toContain('test message sent')
    const d = await hook.next('the test message', (x) => x.payload.title === 'Foreman test ✓')
    expect(d.signatureValid).toBe(true)
    expect(d.payload.schema).toBe('foreman.notification.v1')
    expect(verifySignature('wrong-secret', d.raw, d.headers['x-foreman-signature'])).toBe(false)
    ev(`POST ${d.path}: "${d.payload.title}", X-Foreman-Signature valid (and invalid under a wrong secret), user-agent ${String(d.headers['user-agent'])}`)
    ev('a plain http:// URL is accepted: WebhookChannel does not restrict the URL scheme')
  })

  const tui = await Tui.start(sb)
  await tui.waitForDashboard()

  await j.step('a risky call while `foreman start` runs sends a signed approval notification', async (ev) => {
    const agent = await McpAgent.connect(sb, 'claude-code', { FOREMAN_APPROVAL_TIMEOUT: '5' })
    const reply = agent.call('read_file', { path: 'app/.env' }, 60_000)
    const pending = await sb.row<{ request_id: string; risk_bucket: string }>(
      'the pending approval',
      "SELECT request_id, risk_bucket FROM pending_approvals WHERE args LIKE '%app/.env%'",
    )
    const d = await hook.next('the approval notification', (x) => x.payload.requestId === pending.request_id)
    expect(d.signatureValid).toBe(true)
    expect(d.payload).toMatchObject({ schema: 'foreman.notification.v1', level: 'critical', agentBlocking: true })
    expect(d.payload.title).toContain('claude-code')
    expect(d.payload.title).toContain('read_file')
    expect(d.payload.body).toContain('.env')
    expect(d.payload.actions.map((a) => a.id)).toEqual(expect.arrayContaining(['allow', 'deny']))
    ev(`pending_approvals ${pending.request_id} (risk ${pending.risk_bucket}) → webhook POST, signature valid`)
    ev(`payload: level=${d.payload.level}, agentBlocking=${d.payload.agentBlocking}, title="${d.payload.title}", actions=[${d.payload.actions.map((a) => a.id).join(', ')}]`)

    // Nobody answers: the agent's own deadline (5 s) denies the call.
    const res = await reply
    expect(res.error?.message).toBe('Denied by approval-timeout')
    ev(`agent reply after its 5 s deadline: "${res.error?.message}"`)
    const update = await hook.next(
      'the resolution follow-up',
      (x) => x.payload.title === 'Foreman update' && x.payload.body.includes('app/.env'),
    )
    expect(update.signatureValid).toBe(true)
    expect(update.payload.body).toContain('Denied (timeout default)')
    ev(`follow-up POST "${update.payload.title}" (signed) ends: "${update.payload.body.trim().split('\n').at(-1) ?? ''}"`)
    ev(`ids: approval payload id=${d.payload.id} requestId=${d.payload.requestId}; follow-up id=${update.payload.id} requestId=${update.payload.requestId}`)
    if (update.payload.requestId !== d.payload.requestId && update.payload.id !== d.payload.id) {
      j.note(
        `The webhook follow-up that reports the outcome (title "Foreman update", level ${update.payload.level}) carries id "${update.payload.id}" and requestId ${String(update.payload.requestId)}, so a receiver cannot match it to the approval notification (id ${d.payload.id}, requestId ${d.payload.requestId}) except by parsing the body text.`,
      )
    }

    const rows = sb.query<NotificationRow>(
      'SELECT id, request_id, level, channel, status FROM notifications WHERE request_id = ?',
      pending.request_id,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ level: 'critical', channel: 'webhook', status: 'sent' })
    ev(`notifications row ${rows[0]?.id}: level=critical channel=webhook status=${rows[0]?.status}`)

    const requested = await sb.inboxItem('the approval request', (i) => i.requestId === pending.request_id && i.title.startsWith('Approval needed'))
    expect(requested.title).toBe('Approval needed: claude-code → read_file')
    const outcome = await sb.inboxItem('the approval outcome', (i) => i.requestId === pending.request_id && i.title.startsWith('Denied'))
    expect(outcome.title).toBe('Denied read_file for claude-code')
    expect(outcome.body).toBe('nobody answered in time')
    ev(`foreman inbox --json: "${requested.title}" (${requested.level}, ${requested.body}) and "${outcome.title}" / "${outcome.body}"`)
    const row = await sb.row<{ decision: string; decided_by: string }>('the requests row', 'SELECT decision, decided_by FROM requests WHERE id = ?', pending.request_id)
    expect(row).toEqual({ decision: 'denied', decided_by: 'approval-timeout' })
    ev('requests: denied, decided_by=approval-timeout')
    await agent.close()
  })

  await j.step('every delivery was signed, and nothing but the local receiver was contacted', async (ev) => {
    expect(await tui.stop()).toBe(0)
    expect(hook.deliveries.length).toBeGreaterThanOrEqual(3)
    expect(hook.deliveries.every((d) => d.signatureValid)).toBe(true)
    expect(sb.networkAttempts()).toEqual([])
    ev(`${hook.deliveries.length} webhook deliveries, all with a valid X-Foreman-Signature; network guard: 0 non-loopback connection attempts`)
  })
})
