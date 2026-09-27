import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { approvalSigner } from '../../../src/core/approval-token.js'
import { encodeApprovalButton } from '../../../src/core/notification/channels/approval-buttons.js'
import { SlackChannel } from '../../../src/core/notification/channels/slack.js'
import { SlackSocketListener } from '../../../src/core/notification/channels/slack-socket.js'
import { StaleDecisionError, type Notification, type UserDecision } from '../../../src/core/notification/types.js'
import { fakeSocketServer, httpRecorder, settle, waitFor, type RecordedCall } from './fake-socket.js'

// =============================================================================
// #615 — Two-way Slack over Socket Mode, against a fake socket server.
// =============================================================================

const sign = approvalSigner(randomBytes(32))
const OWNER = 'U0OWNER1'
const RESPONSE_URL = 'https://hooks.slack.com/actions/T1/1/xyz'

function slackApi(overrides: Record<string, unknown> = {}) {
  let opened = 0
  return httpRecorder((url) => {
    if (url.endsWith('/apps.connections.open')) {
      opened += 1
      return { body: overrides.open ?? { ok: true, url: `wss://wss-primary.slack.com/link/?ticket=${opened}` } }
    }
    if (url.endsWith('/chat.postMessage')) return { body: { ok: true, channel: 'C1', ts: '1.1' } }
    return { body: 'ok' }
  })
}

const blockActions = (userId: string, value: string) => ({
  envelope_id: `env-${Math.random()}`,
  type: 'interactive',
  accepts_response_payload: false,
  payload: {
    type: 'block_actions',
    user: { id: userId },
    response_url: RESPONSE_URL,
    actions: [{ action_id: 'foreman_allow', value }],
    message: {
      text: 'Approval needed',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: 'Approval needed' } },
        { type: 'actions', elements: [] },
      ],
    },
  },
})

const responses = (calls: RecordedCall[]) =>
  calls.filter((c) => c.url === RESPONSE_URL).map((c) => c.body as Record<string, unknown>)

describe('SlackSocketListener', () => {
  const listeners: SlackSocketListener[] = []
  const make = (opts: Partial<ConstructorParameters<typeof SlackSocketListener>[0]> = {}) => {
    const server = fakeSocketServer()
    const api = slackApi()
    const warnings: string[] = []
    const listener = new SlackSocketListener({
      appToken: 'xapp-1-test',
      allowedUserIds: [OWNER],
      sign,
      fetchImpl: api.fetchImpl,
      socketFactory: server.factory,
      onWarning: (w) => warnings.push(w),
      backoffMs: { min: 10, max: 20 },
      ...opts,
    })
    listeners.push(listener)
    return { listener, server, api, warnings }
  }
  afterEach(async () => {
    for (const l of listeners.splice(0)) await l.stop()
  })

  it('opens the socket with the app token and acknowledges every envelope', async () => {
    const { listener, server, api } = make()
    listener.start(async () => {})
    const socket = await server.connection(1)
    const open = api.calls.find((c) => c.url.endsWith('/apps.connections.open'))!
    expect(open.headers.authorization).toBe('Bearer xapp-1-test')
    expect(socket.url).toBe('wss://wss-primary.slack.com/link/?ticket=1')
    socket.receive({ type: 'hello' })
    socket.receive({ envelope_id: 'e-1', type: 'events_api', payload: { type: 'event_callback' } })
    await settle()
    expect(socket.sent).toEqual([{ envelope_id: 'e-1' }])
  })

  it("turns the owner's button press into a decision and replaces the buttons", async () => {
    const decisions: UserDecision[] = []
    const { listener, server, api } = make()
    listener.start(async (d) => {
      decisions.push(d)
    })
    const socket = await server.connection(1)
    socket.receive(blockActions(OWNER, encodeApprovalButton('req-9', 'allow', sign)))
    await waitFor(() => responses(api.calls).length > 0)
    expect(decisions).toMatchObject([{ requestId: 'req-9', decision: 'allow', decidedBy: `slack:${OWNER}`, channel: 'slack' }])
    const [reply] = responses(api.calls)
    expect(reply!.replace_original).toBe(true)
    const blocks = reply!.blocks as Array<{ type: string }>
    expect(blocks.map((b) => b.type)).toEqual(['header', 'context'])
    expect(JSON.stringify(blocks)).toContain(`Allowed ✓ by <@${OWNER}>`)
    expect(socket.sent).toHaveLength(1) // acked
  })

  it('rejects anyone not on the allowed list, and forged or swapped buttons', async () => {
    const decisions: UserDecision[] = []
    const { listener, server, api } = make()
    listener.start(async (d) => {
      decisions.push(d)
    })
    const socket = await server.connection(1)
    socket.receive(blockActions('U0STRANGER', encodeApprovalButton('req-9', 'allow', sign)))
    // A deny button's tag replayed as allow.
    const deny = encodeApprovalButton('req-9', 'deny', sign)
    socket.receive(blockActions(OWNER, deny.replace('fa:deny:', 'fa:allow:')))
    socket.receive(blockActions(OWNER, 'fa:allow:req-9.forgedtag0'))
    await waitFor(() => responses(api.calls).length === 3)
    expect(decisions).toEqual([])
    const texts = responses(api.calls).map((r) => r.text)
    expect(texts).toEqual([
      'You are not allowed to decide Foreman approvals.',
      'This button is no longer valid.',
      'This button is no longer valid.',
    ])
    expect(responses(api.calls).every((r) => r.response_type === 'ephemeral')).toBe(true)
  })

  it('says so when the approval was already decided', async () => {
    const { listener, server, api } = make()
    listener.start(async () => {
      throw new StaleDecisionError()
    })
    const socket = await server.connection(1)
    socket.receive(blockActions(OWNER, encodeApprovalButton('req-1', 'allow', sign)))
    await waitFor(() => responses(api.calls).length > 0)
    expect(JSON.stringify(responses(api.calls)[0])).toContain('Already decided.')
  })

  it('runs /foreman for allowed users and answers privately', async () => {
    const commands: Array<[string, string]> = []
    const { listener, server, api } = make({
      onCommand: async (text, user) => {
        commands.push([text, user])
        return 'codex: running'
      },
    })
    listener.start(async () => {})
    const socket = await server.connection(1)
    const slash = (user: string) => ({
      envelope_id: 'e-slash',
      type: 'slash_commands',
      payload: { command: '/foreman', text: 'status', user_id: user, response_url: RESPONSE_URL },
    })
    socket.receive(slash('U0STRANGER'))
    socket.receive(slash(OWNER))
    await waitFor(() => responses(api.calls).length === 2)
    expect(commands).toEqual([['status', OWNER]])
    const [denied, answer] = responses(api.calls)
    expect(denied!.text).toBe('You are not allowed to command Foreman.')
    expect(answer!.response_type).toBe('ephemeral')
    expect(answer!.text).toContain('codex: running')
  })

  it('ignores response URLs that are not Slack', async () => {
    const { listener, server, api } = make()
    listener.start(async () => {})
    const socket = await server.connection(1)
    const evil = blockActions('U0STRANGER', 'x')
    evil.payload.response_url = 'https://attacker.example/collect'
    socket.receive(evil)
    await settle(40)
    expect(api.calls.filter((c) => c.url.includes('attacker'))).toEqual([])
  })

  it('reconnects: at once after a refresh, with backoff after a drop', async () => {
    const { listener, server, api } = make()
    listener.start(async () => {})
    const first = await server.connection(1)
    first.receive({ type: 'disconnect', reason: 'refresh_requested' })
    const second = await server.connection(2)
    expect(second.url).toContain('ticket=2')
    second.serverClose(1006)
    const third = await server.connection(3)
    expect(third.url).toContain('ticket=3')
    expect(api.calls.filter((c) => c.url.endsWith('/apps.connections.open'))).toHaveLength(3)
  })

  it('stops with a warning when Slack rejects the app token', async () => {
    const server = fakeSocketServer()
    const api = httpRecorder(() => ({ body: { ok: false, error: 'invalid_auth' } }))
    const warnings: string[] = []
    const listener = new SlackSocketListener({
      appToken: 'xapp-bad',
      allowedUserIds: [OWNER],
      sign,
      fetchImpl: api.fetchImpl,
      socketFactory: server.factory,
      onWarning: (w) => warnings.push(w),
      backoffMs: { min: 5, max: 5 },
    })
    listeners.push(listener)
    listener.start(async () => {})
    await waitFor(() => warnings.length > 0)
    await settle(40)
    expect(warnings[0]).toContain('invalid_auth')
    expect(api.calls).toHaveLength(1)
    expect(server.sockets).toHaveLength(0)
  })
})

describe('SlackChannel two-way rendering', () => {
  const approval: Notification = {
    id: 'n-1',
    level: 'critical',
    requestId: 'req-42',
    title: 'Approval needed',
    body: 'codex wants shell_exec',
    actions: [
      { id: 'allow', label: 'Allow' },
      { id: 'deny', label: 'Deny' },
      { id: 'allow_always', label: 'Always allow' },
      { id: 'block_secret_path', label: 'Block pattern', intent: 'custom', payload: { rule: 'x' } },
    ],
    agentBlocking: true,
  }

  it('adds signed buttons for approval actions only, and no push-only hint', async () => {
    const api = slackApi()
    const channel = new SlackChannel({
      target: { kind: 'bot', token: 'xoxb-1', channel: 'alerts' },
      fetchImpl: api.fetchImpl,
      interactive: { appToken: 'xapp-1', allowedUserIds: [OWNER], sign, socketFactory: fakeSocketServer().factory },
    })
    await channel.send(approval)
    const post = api.calls.find((c) => c.url.endsWith('/chat.postMessage'))!.body as { blocks: Array<Record<string, unknown>> }
    const actions = post.blocks.find((b) => b.type === 'actions') as { elements: Array<{ value: string; action_id: string }> }
    expect(actions.elements.map((e) => e.action_id)).toEqual(['foreman_allow', 'foreman_deny', 'foreman_allow_always'])
    expect(actions.elements[0]!.value).toBe(encodeApprovalButton('req-42', 'allow', sign))
    expect(JSON.stringify(post.blocks)).not.toContain('Decide in the Foreman TUI')
  })

  it('stays push-only without two-way mode', async () => {
    const api = slackApi()
    const channel = new SlackChannel({ target: { kind: 'bot', token: 'xoxb-1', channel: 'alerts' }, fetchImpl: api.fetchImpl })
    await channel.send(approval)
    const post = api.calls.find((c) => c.url.endsWith('/chat.postMessage'))!.body as { blocks: Array<Record<string, unknown>> }
    expect(post.blocks.some((b) => b.type === 'actions')).toBe(false)
    expect(JSON.stringify(post.blocks)).not.toContain('fa:allow')
  })
})

describe('Slack end to end: agent call → Slack button → agent unblocked', () => {
  it('a button press allows the waiting call, audited as user:slack; a second press is stale', async () => {
    const { BusApprovalService } = await import('../../../src/core/approval.js')
    const { EventBus } = await import('../../../src/core/event-bus.js')
    const { MediatorService } = await import('../../../src/core/mediator.js')
    const { NotificationBridge } = await import('../../../src/core/notification/notification-bridge.js')
    const { NotificationService } = await import('../../../src/core/notification/notification-service.js')
    const { defaultNotifyConfig } = await import('../../../src/core/notification/notify-config.js')
    const { PolicyEngine } = await import('../../../src/core/policy-engine.js')
    const { RegistryService } = await import('../../../src/core/registry.js')
    const { RiskScorer } = await import('../../../src/core/risk-scorer.js')
    const { createInMemoryDb } = await import('../../../src/db/client.js')

    const { db, sqlite } = createInMemoryDb()
    const bus = new EventBus<import('../../../src/core/event-bus.js').ForemanEventMap>()
    const registry = new RegistryService(db, bus)
    const mediator = new MediatorService({
      registry,
      policy: new PolicyEngine(db, bus),
      risk: new RiskScorer(db),
      approval: new BusApprovalService({ bus, timeoutMs: 5_000 }),
      bus,
    })
    const server = fakeSocketServer()
    const api = slackApi()
    const channel = new SlackChannel({
      target: { kind: 'bot', token: 'xoxb-1', channel: 'alerts' },
      fetchImpl: api.fetchImpl,
      interactive: { appToken: 'xapp-1', allowedUserIds: [OWNER], sign, socketFactory: server.factory },
    })
    const config = defaultNotifyConfig()
    config.channels.slack = { enabled: true, bot_token_ref: 'b', channel: 'alerts', app_token_ref: 'a', allowed_user_ids: [OWNER] }
    config.routing.critical = { channels: ['slack'], timeout_seconds: 300, default_action: 'deny' }
    config.routing.warning = { channels: ['slack'], timeout_seconds: 0, default_action: 'deny' }
    const bridge = new NotificationBridge(new NotificationService({ db, config, channels: new Map([['slack', channel]]) }), { bus })
    await bridge.start()
    try {
      const socket = await server.connection(1)
      const call = mediator.handleRequest({
        sourceAgent: 'hermes',
        targetTool: 'read_file',
        message: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'read_file', arguments: { path: '/home/me/app/.env' } },
        } as never,
      })
      await waitFor(() => api.calls.some((c) => c.url.endsWith('/chat.postMessage')))
      const post = api.calls.find((c) => c.url.endsWith('/chat.postMessage'))!.body as { blocks: Array<Record<string, unknown>> }
      const buttons = (post.blocks.find((b) => b.type === 'actions') as { elements: Array<{ value: string }> }).elements
      const allow = buttons.find((b) => b.value.startsWith('fa:allow:'))!.value
      socket.receive(blockActions(OWNER, allow))
      const result = await call
      expect(result.decision).toBe('allowed')
      expect(result.decidedBy).toBe('user:slack')
      // The same button pressed again (another device, a double tap).
      socket.receive(blockActions(OWNER, allow))
      await waitFor(() => responses(api.calls).length === 2)
      expect(JSON.stringify(responses(api.calls)[1])).toContain('Already decided.')
    } finally {
      await bridge.stop()
      sqlite.close()
    }
  })
})
