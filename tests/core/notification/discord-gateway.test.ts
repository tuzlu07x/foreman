import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { approvalSigner } from '../../../src/core/approval-token.js'
import { encodeApprovalButton } from '../../../src/core/notification/channels/approval-buttons.js'
import { DiscordChannel, renderDiscordMessage } from '../../../src/core/notification/channels/discord.js'
import { DiscordGatewayListener } from '../../../src/core/notification/channels/discord-gateway.js'
import type { InteractionRefusal } from '../../../src/core/notification/interaction-refusals.js'
import type { Notification, UserDecision } from '../../../src/core/notification/types.js'
import { fakeSocketServer, httpRecorder, settle, waitFor, type FakeSocket } from './fake-socket.js'

// =============================================================================
// #615 — Two-way Discord over the Gateway, against a fake gateway.
// =============================================================================

const sign = approvalSigner(randomBytes(32))
const OWNER = '111111111111111111'
const APP = '222222222222222222'
const TOKEN = 'interaction-token-abcdef'

function discordApi() {
  return httpRecorder(() => ({ body: {} }))
}

/** Hello → Identify → READY, as Discord does it. */
function handshake(socket: FakeSocket, seq = 1): void {
  socket.receive({ op: 10, d: { heartbeat_interval: 60_000 } })
  socket.receive({
    op: 0,
    t: 'READY',
    s: seq,
    d: { session_id: 'sess-1', resume_gateway_url: 'wss://resume.discord.gg', application: { id: APP } },
  })
}

const button = (userId: string, customId: string, id = '333333333333333333') => ({
  op: 0,
  t: 'INTERACTION_CREATE',
  s: 2,
  d: {
    id,
    token: TOKEN,
    type: 3,
    application_id: APP,
    member: { user: { id: userId } },
    data: { custom_id: customId, component_type: 2 },
  },
})

describe('DiscordGatewayListener', () => {
  const listeners: DiscordGatewayListener[] = []
  const make = (opts: Partial<ConstructorParameters<typeof DiscordGatewayListener>[0]> = {}) => {
    const server = fakeSocketServer()
    const api = discordApi()
    const warnings: string[] = []
    const listener = new DiscordGatewayListener({
      botToken: 'bot-token',
      allowedUserIds: [OWNER],
      sign,
      fetchImpl: api.fetchImpl,
      socketFactory: server.factory,
      onWarning: (w) => warnings.push(w),
      backoffMs: { min: 10, max: 20 },
      random: () => 0,
      ...opts,
    })
    listeners.push(listener)
    return { listener, server, api, warnings }
  }
  afterEach(async () => {
    for (const l of listeners.splice(0)) await l.stop()
  })

  it('identifies with intents 0 after Hello, heartbeats, and registers /foreman on READY', async () => {
    const { listener, server, api } = make({ onCommand: async () => 'ok' })
    listener.start(async () => {})
    const socket = await server.connection(1)
    expect(socket.url).toBe('wss://gateway.discord.gg/?v=10&encoding=json')
    handshake(socket)
    await waitFor(() => api.calls.length > 0)
    expect(socket.sent.find((p) => p.op === 2)).toMatchObject({ op: 2, d: { token: 'bot-token', intents: 0 } })
    // First heartbeat fires at interval × jitter (0 here).
    await waitFor(() => socket.sent.some((p) => p.op === 1))
    const register = api.calls[0]!
    expect(register.url).toBe(`https://discord.com/api/v10/applications/${APP}/commands`)
    expect(register.headers.authorization).toBe('Bot bot-token')
    expect(register.body).toMatchObject({ name: 'foreman', type: 1 })
  })

  it("turns the owner's button press into a decision and removes the buttons", async () => {
    const decisions: UserDecision[] = []
    const { listener, server, api } = make()
    listener.start(async (d) => {
      decisions.push(d)
    })
    const socket = await server.connection(1)
    handshake(socket)
    socket.receive(button(OWNER, encodeApprovalButton('req-7', 'deny_always', sign)))
    await waitFor(() => api.calls.some((c) => c.url.includes('/interactions/')))
    expect(decisions).toMatchObject([{ requestId: 'req-7', decision: 'deny_always', decidedBy: `discord:${OWNER}`, channel: 'discord', userId: OWNER }])
    const callback = api.calls.find((c) => c.url.includes('/interactions/'))!
    expect(callback.url).toBe(`https://discord.com/api/v10/interactions/333333333333333333/${TOKEN}/callback`)
    expect(callback.body).toMatchObject({ type: 7, data: { components: [], content: `Denied ✗ (always) by <@${OWNER}>` } })
  })

  it('rejects other users and forged buttons with a private reply', async () => {
    const decisions: UserDecision[] = []
    const { listener, server, api } = make()
    listener.start(async (d) => {
      decisions.push(d)
    })
    const socket = await server.connection(1)
    handshake(socket)
    socket.receive(button('999999999999999999', encodeApprovalButton('req-7', 'allow', sign)))
    socket.receive(button(OWNER, 'fa:allow:req-7.notthetag0', '444444444444444444'))
    await waitFor(() => api.calls.filter((c) => c.url.includes('/interactions/')).length === 2)
    expect(decisions).toEqual([])
    const bodies = api.calls.filter((c) => c.url.includes('/interactions/')).map((c) => c.body)
    expect(bodies).toEqual([
      { type: 4, data: { content: 'You are not allowed to use Foreman here.', flags: 64, allowed_mentions: { parse: [] } } },
      { type: 4, data: { content: 'This button is no longer valid.', flags: 64, allowed_mentions: { parse: [] } } },
    ])
  })

  it('reports refused buttons and commands for the audit log, without the text', async () => {
    const refused: InteractionRefusal[] = []
    const { listener, server, api } = make({ onRefused: (r) => refused.push(r), onCommand: async () => 'ok' })
    listener.start(async () => {})
    const socket = await server.connection(1)
    handshake(socket)
    const STRANGER = '999999999999999999'
    socket.receive(button(STRANGER, encodeApprovalButton('req-7', 'deny', sign)))
    socket.receive(button(STRANGER, 'fa:allow:req-8.notthetag0', '444444444444444444'))
    socket.receive({
      op: 0,
      t: 'INTERACTION_CREATE',
      s: 3,
      d: {
        id: '555555555555555555',
        token: TOKEN,
        type: 2,
        application_id: APP,
        member: { user: { id: STRANGER } },
        data: { name: 'foreman', options: [{ name: 'command', value: 'integration disable github please' }] },
      },
    })
    await waitFor(() => api.calls.filter((c) => c.url.includes('/interactions/')).length === 3)
    expect(refused).toEqual([
      { platform: 'discord', userId: STRANGER, attempted: 'button:deny', requestId: 'req-7' },
      // A forged tag: what it claimed, but no approval id.
      { platform: 'discord', userId: STRANGER, attempted: 'button:allow' },
      { platform: 'discord', userId: STRANGER, attempted: 'command:integration' },
    ])
    expect(JSON.stringify(refused)).not.toContain('please')
  })

  it('runs /foreman with a deferred private reply', async () => {
    const { listener, server, api } = make({ onCommand: async (text) => `ran: ${text}` })
    listener.start(async () => {})
    const socket = await server.connection(1)
    handshake(socket)
    socket.receive({
      op: 0,
      t: 'INTERACTION_CREATE',
      s: 3,
      d: {
        id: '555555555555555555',
        token: TOKEN,
        type: 2,
        application_id: APP,
        user: { id: OWNER },
        data: { name: 'foreman', options: [{ name: 'command', type: 3, value: 'org' }] },
      },
    })
    await waitFor(() => api.calls.some((c) => c.method === 'PATCH'))
    const deferred = api.calls.find((c) => c.url.includes('/interactions/555555555555555555/'))!
    expect(deferred.body).toEqual({ type: 5, data: { flags: 64 } })
    const edit = api.calls.find((c) => c.method === 'PATCH')!
    expect(edit.url).toBe(`https://discord.com/api/v10/webhooks/${APP}/${TOKEN}/messages/@original`)
    expect((edit.body as { content: string }).content).toContain('ran: org')
  })

  it('resumes the session when Discord asks for a reconnect', async () => {
    const { listener, server } = make()
    listener.start(async () => {})
    const first = await server.connection(1)
    handshake(first, 41)
    first.receive({ op: 7, d: null })
    const second = await server.connection(2)
    expect(second.url).toBe('wss://resume.discord.gg/?v=10&encoding=json')
    second.receive({ op: 10, d: { heartbeat_interval: 60_000 } })
    await waitFor(() => second.sent.some((p) => p.op === 6))
    expect(second.sent.find((p) => p.op === 6)).toEqual({ op: 6, d: { token: 'bot-token', session_id: 'sess-1', seq: 41 } })
  })

  it('identifies afresh after an invalid, non-resumable session', async () => {
    const { listener, server } = make()
    listener.start(async () => {})
    const first = await server.connection(1)
    handshake(first)
    first.receive({ op: 9, d: false })
    const second = await server.connection(2)
    expect(second.url).toBe('wss://gateway.discord.gg/?v=10&encoding=json')
    second.receive({ op: 10, d: { heartbeat_interval: 60_000 } })
    await waitFor(() => second.sent.some((p) => p.op === 2))
  })

  it('reconnects when heartbeats stop being acknowledged', async () => {
    const { listener, server } = make()
    listener.start(async () => {})
    const first = await server.connection(1)
    first.receive({ op: 10, d: { heartbeat_interval: 30 } })
    // No op 11 ever comes back: the second beat finds the first un-acked.
    const second = await server.connection(2)
    expect(first.closed?.code).toBe(4000)
    expect(second).toBeDefined()
  })

  it('recovers from a dead link that never answers our close, and stops promptly', async () => {
    const server = fakeSocketServer({ silent: true })
    const listener = new DiscordGatewayListener({
      botToken: 'bot-token',
      allowedUserIds: [OWNER],
      sign,
      fetchImpl: discordApi().fetchImpl,
      socketFactory: server.factory,
      backoffMs: { min: 10, max: 20 },
      random: () => 0,
      closeGraceMs: 30,
    })
    listeners.push(listener)
    listener.start(async () => {})
    const first = await server.connection(1)
    first.receive({ op: 10, d: { heartbeat_interval: 20 } })
    // No ACK and no close frame ever comes back.
    const second = await server.connection(2)
    expect(first.closed?.code).toBe(4000)
    // Frames from the abandoned socket are ignored.
    const before = first.sent.length
    first.receive({ op: 10, d: { heartbeat_interval: 20 } })
    await settle(10)
    expect(first.sent).toHaveLength(before)
    expect(second).toBeDefined()
    const started = Date.now()
    await listener.stop()
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('stops with a warning when the token is rejected', async () => {
    const { listener, server, warnings } = make()
    listener.start(async () => {})
    const first = await server.connection(1)
    first.serverClose(4004, 'Authentication failed')
    await waitFor(() => warnings.length > 0)
    await settle(60)
    expect(warnings[0]).toContain('4004')
    expect(server.sockets).toHaveLength(1)
  })
})

describe('DiscordChannel two-way rendering', () => {
  const approval: Notification = {
    id: 'n-1',
    level: 'critical',
    requestId: 'req-42',
    title: 'Approval needed',
    body: 'codex wants shell_exec',
    actions: [
      { id: 'allow', label: 'Allow' },
      { id: 'deny', label: 'Deny' },
    ],
    agentBlocking: true,
  }

  it('adds signed buttons in bot mode, and removes them with the outcome', async () => {
    const payload = renderDiscordMessage(approval, sign) as {
      components: Array<{ components: Array<{ custom_id: string; style: number }> }>
    }
    const buttons = payload.components[0]!.components
    expect(buttons.map((b) => b.custom_id)).toEqual([
      encodeApprovalButton('req-42', 'allow', sign),
      encodeApprovalButton('req-42', 'deny', sign),
    ])
    expect(buttons.map((b) => b.style)).toEqual([3, 4])
    expect(buttons.every((b) => b.custom_id.length <= 100)).toBe(true)

    const api = discordApi()
    const channel = new DiscordChannel({
      target: { kind: 'bot', token: 't', channelId: '777777777777777777' },
      fetchImpl: api.fetchImpl,
      interactive: { allowedUserIds: [OWNER], sign, socketFactory: fakeSocketServer().factory },
    })
    await channel.updateMessage({ channelMessageId: '888' }, '⏱ 4m left')
    await channel.updateMessage({ channelMessageId: '888' }, '✓ Allowed', { final: true })
    expect(api.calls.map((c) => 'components' in (c.body as object))).toEqual([false, true])
  })

  it('stays push-only without a signer', () => {
    const payload = renderDiscordMessage(approval) as Record<string, unknown>
    expect(payload.components).toBeUndefined()
  })
})
