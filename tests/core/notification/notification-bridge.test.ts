import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus, type ForemanEventMap } from '../../../src/core/event-bus.js'
import { NotificationBridge } from '../../../src/core/notification/notification-bridge.js'
import { NotificationService } from '../../../src/core/notification/notification-service.js'
import {
  defaultNotifyConfig,
  type NotifyConfig,
} from '../../../src/core/notification/notify-config.js'
import type {
  ChannelId,
  ChannelMessageRef,
  Notification,
  NotificationChannel,
  UserDecision,
} from '../../../src/core/notification/types.js'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'

class FakeChannel implements NotificationChannel {
  readonly id: ChannelId
  sendCalls: Notification[] = []
  updateCalls: { ref: ChannelMessageRef; body: string }[] = []
  listenHandler: ((d: UserDecision) => Promise<void>) | null = null

  constructor(id: ChannelId) {
    this.id = id
  }
  async isReady(): Promise<boolean> {
    return true
  }
  async send(n: Notification): Promise<ChannelMessageRef> {
    this.sendCalls.push(n)
    return { channelMessageId: `msg-${this.sendCalls.length}` }
  }
  async updateMessage(ref: ChannelMessageRef, body: string): Promise<void> {
    this.updateCalls.push({ ref, body })
  }
  async listen(handler: (d: UserDecision) => Promise<void>): Promise<void> {
    this.listenHandler = handler
  }
  async shutdown(): Promise<void> {
    this.listenHandler = null
  }
}

function approvalEvent(
  overrides: Partial<ForemanEventMap['approval:requested']> = {},
): ForemanEventMap['approval:requested'] {
  return {
    requestId: 'r-1',
    sourceAgent: 'hermes',
    targetAgent: 'claude-code',
    targetTool: 'read_file',
    args: { path: '.env' },
    riskScore: 80,
    riskReasons: ['secret_path'],
    riskFactors: [
      {
        rule: 'secret_path',
        category: 'secret',
        points: 60,
        reason: '.env-style file',
      },
    ],
    riskBucket: 'high',
    llmVerification: null,
    securityReport: null,
    sessionId: 'sess-1',
    ...overrides,
  }
}

function configWithTelegram(): NotifyConfig {
  const c = defaultNotifyConfig()
  c.channels.telegram = {
    enabled: true,
    bot_token_ref: 'tg',
    chat_id: '1',
  }
  return c
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

describe('NotificationBridge — bus.on(approval:requested) → channel.send', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let channel: FakeChannel
  let service: NotificationService
  let bridge: NotificationBridge

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    channel = new FakeChannel('telegram')
    service = new NotificationService({
      db,
      config: configWithTelegram(),
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })
    bridge = new NotificationBridge(service, { bus })
  })

  afterEach(async () => {
    await bridge.stop()
    sqlite.close()
  })

  it('sends a notification when approval:requested fires', async () => {
    await bridge.start()
    bus.emit('approval:requested', approvalEvent())
    await tick()

    expect(channel.sendCalls).toHaveLength(1)
    expect(channel.sendCalls[0]!.requestId).toBe('r-1')
    expect(channel.sendCalls[0]!.title).toContain('hermes → claude-code')
  })

  it('routes critical-bucket requests to the critical level config', async () => {
    await bridge.start()
    bus.emit('approval:requested', approvalEvent({ riskBucket: 'critical' }))
    await tick()
    expect(channel.sendCalls[0]!.level).toBe('critical')
  })

  it('routes medium-bucket requests to warning', async () => {
    // Warning level routes to telegram by default
    await bridge.start()
    bus.emit('approval:requested', approvalEvent({ riskBucket: 'medium' }))
    await tick()
    expect(channel.sendCalls[0]!.level).toBe('warning')
  })

  it('does not throw or block the bus when send fails', async () => {
    const errChannel = new FakeChannel('telegram')
    errChannel.send = async () => {
      throw new Error('boom')
    }
    const failingService = new NotificationService({
      db,
      config: configWithTelegram(),
      channels: new Map<ChannelId, NotificationChannel>([
        ['telegram', errChannel],
      ]),
    })
    const failingBridge = new NotificationBridge(failingService, { bus })
    await failingBridge.start()
    expect(() => bus.emit('approval:requested', approvalEvent())).not.toThrow()
    await tick()
    // The channel was called even though it threw
    await failingBridge.stop()
  })
})

describe('NotificationBridge — channel decision → bus.emit(approval:resolved)', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let channel: FakeChannel
  let service: NotificationService
  let bridge: NotificationBridge
  let resolvedEvents: ForemanEventMap['approval:resolved'][]

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    channel = new FakeChannel('telegram')
    service = new NotificationService({
      db,
      config: configWithTelegram(),
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })
    bridge = new NotificationBridge(service, { bus })
    resolvedEvents = []
    bus.on('approval:resolved', (e) => resolvedEvents.push(e))
  })

  afterEach(async () => {
    await bridge.stop()
    sqlite.close()
  })

  it('OOB allow tap → approval:resolved (decision=allowed, no remember)', async () => {
    await bridge.start()
    bus.emit('approval:requested', approvalEvent())
    await tick()
    const notificationId = channel.sendCalls[0]!.id

    await channel.listenHandler!({
      notificationId,
      decision: 'allow',
      decidedBy: '777',
      decidedAt: Date.now(),
    })

    expect(resolvedEvents).toHaveLength(1)
    expect(resolvedEvents[0]).toMatchObject({
      requestId: 'r-1',
      decision: 'allowed',
      resolvedBy: 'user',
    })
    expect(resolvedEvents[0]!.remember).toBeUndefined()
  })

  it('OOB allow_always → emits remember=allow', async () => {
    await bridge.start()
    bus.emit('approval:requested', approvalEvent())
    await tick()
    const id = channel.sendCalls[0]!.id
    await channel.listenHandler!({
      notificationId: id,
      decision: 'allow_always',
      decidedBy: '777',
      decidedAt: Date.now(),
    })
    expect(resolvedEvents[0]!.decision).toBe('allowed')
    expect(resolvedEvents[0]!.remember).toBe('allow')
  })

  it('OOB deny_always → emits decision=denied, remember=deny', async () => {
    await bridge.start()
    bus.emit('approval:requested', approvalEvent())
    await tick()
    const id = channel.sendCalls[0]!.id
    await channel.listenHandler!({
      notificationId: id,
      decision: 'deny_always',
      decidedBy: '777',
      decidedAt: Date.now(),
    })
    expect(resolvedEvents[0]!.decision).toBe('denied')
    expect(resolvedEvents[0]!.remember).toBe('deny')
  })

  it('ignores decisions for unknown notifications', async () => {
    await bridge.start()
    await channel.listenHandler!({
      notificationId: 'never-sent',
      decision: 'allow',
      decidedBy: '777',
      decidedAt: Date.now(),
    })
    expect(resolvedEvents).toEqual([])
  })
})

describe('NotificationBridge — race handling (resolved elsewhere)', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let channel: FakeChannel
  let bridge: NotificationBridge

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    channel = new FakeChannel('telegram')
    const service = new NotificationService({
      db,
      config: configWithTelegram(),
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })
    bridge = new NotificationBridge(service, { bus })
  })

  afterEach(async () => {
    await bridge.stop()
    sqlite.close()
  })

  it('TUI resolution after channel send → channel.updateMessage called with "elsewhere" footer', async () => {
    await bridge.start()
    bus.emit('approval:requested', approvalEvent())
    await tick()
    expect(channel.sendCalls).toHaveLength(1)

    bus.emit('approval:resolved', {
      requestId: 'r-1',
      decision: 'denied',
      resolvedBy: 'user',
    })
    await tick()

    expect(channel.updateCalls).toHaveLength(1)
    expect(channel.updateCalls[0]!.body).toContain('✗ Denied')
    expect(channel.updateCalls[0]!.body).toContain('elsewhere')
  })

  it('does not crash when no notifications were sent for this requestId', async () => {
    await bridge.start()
    expect(() =>
      bus.emit('approval:resolved', {
        requestId: 'unknown',
        decision: 'allowed',
        resolvedBy: 'user',
      }),
    ).not.toThrow()
    await tick()
    expect(channel.updateCalls).toEqual([])
  })

  it('updateMessage failure does not surface (best-effort)', async () => {
    channel.updateMessage = vi.fn().mockRejectedValue(new Error('rate limit'))
    await bridge.start()
    bus.emit('approval:requested', approvalEvent())
    await tick()
    expect(() =>
      bus.emit('approval:resolved', {
        requestId: 'r-1',
        decision: 'allowed',
        resolvedBy: 'user',
      }),
    ).not.toThrow()
  })

  it('cleans up outstanding map after resolution (no double-update on second resolved)', async () => {
    await bridge.start()
    bus.emit('approval:requested', approvalEvent())
    await tick()

    bus.emit('approval:resolved', {
      requestId: 'r-1',
      decision: 'denied',
      resolvedBy: 'user',
    })
    await tick()
    bus.emit('approval:resolved', {
      requestId: 'r-1',
      decision: 'allowed',
      resolvedBy: 'user',
    })
    await tick()

    expect(channel.updateCalls).toHaveLength(1)
  })
})

describe('NotificationBridge — state filtering (silence + mute)', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let channel: FakeChannel

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    channel = new FakeChannel('telegram')
  })

  afterEach(() => {
    sqlite.close()
  })

  it('drops non-critical notifications during a silence window', async () => {
    const service = new NotificationService({
      db,
      config: configWithTelegram(),
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })
    const bridge = new NotificationBridge(service, {
      bus,
      getState: () => ({
        silencedUntil: Date.now() + 60_000,
        mutedAgents: [],
      }),
    })
    await bridge.start()

    bus.emit('approval:requested', approvalEvent({ riskBucket: 'medium' }))
    await tick()
    expect(channel.sendCalls).toEqual([])
    await bridge.stop()
  })

  it('still delivers CRITICAL alerts during a silence window', async () => {
    const service = new NotificationService({
      db,
      config: configWithTelegram(),
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })
    const bridge = new NotificationBridge(service, {
      bus,
      getState: () => ({
        silencedUntil: Date.now() + 60_000,
        mutedAgents: [],
      }),
    })
    await bridge.start()

    bus.emit('approval:requested', approvalEvent({ riskBucket: 'critical' }))
    await tick()
    expect(channel.sendCalls).toHaveLength(1)
    expect(channel.sendCalls[0]!.level).toBe('critical')
    await bridge.stop()
  })

  it('drops notifications from muted source agents (any level)', async () => {
    const service = new NotificationService({
      db,
      config: configWithTelegram(),
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })
    const bridge = new NotificationBridge(service, {
      bus,
      getState: () => ({
        silencedUntil: null,
        mutedAgents: ['hermes'],
      }),
    })
    await bridge.start()

    bus.emit('approval:requested', approvalEvent({ sourceAgent: 'hermes' }))
    await tick()
    expect(channel.sendCalls).toEqual([])

    // Other agents still alert
    bus.emit('approval:requested', approvalEvent({ sourceAgent: 'openclaw' }))
    await tick()
    expect(channel.sendCalls).toHaveLength(1)
    await bridge.stop()
  })

  it('re-reads state on every dispatch (live updates without restart)', async () => {
    let muted: string[] = []
    const service = new NotificationService({
      db,
      config: configWithTelegram(),
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })
    const bridge = new NotificationBridge(service, {
      bus,
      getState: () => ({ silencedUntil: null, mutedAgents: [...muted] }),
    })
    await bridge.start()

    bus.emit('approval:requested', approvalEvent({ sourceAgent: 'hermes' }))
    await tick()
    expect(channel.sendCalls).toHaveLength(1)

    muted = ['hermes']
    bus.emit('approval:requested', approvalEvent({ sourceAgent: 'hermes' }))
    await tick()
    expect(channel.sendCalls).toHaveLength(1) // not 2
    await bridge.stop()
  })
})

describe('NotificationBridge — lifecycle', () => {
  it('start is idempotent', async () => {
    const handle = createInMemoryDb()
    const bus = new EventBus<ForemanEventMap>()
    const channel = new FakeChannel('telegram')
    const service = new NotificationService({
      db: handle.db,
      config: configWithTelegram(),
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })
    const bridge = new NotificationBridge(service, { bus })
    await bridge.start()
    await bridge.start() // second call is a no-op
    bus.emit('approval:requested', approvalEvent())
    await tick()
    expect(channel.sendCalls).toHaveLength(1)
    await bridge.stop()
    handle.sqlite.close()
  })

  it('stop unhooks bus listeners — subsequent emits are silent', async () => {
    const handle = createInMemoryDb()
    const bus = new EventBus<ForemanEventMap>()
    const channel = new FakeChannel('telegram')
    const service = new NotificationService({
      db: handle.db,
      config: configWithTelegram(),
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })
    const bridge = new NotificationBridge(service, { bus })
    await bridge.start()
    await bridge.stop()

    bus.emit('approval:requested', approvalEvent())
    await tick()
    expect(channel.sendCalls).toEqual([])

    handle.sqlite.close()
  })
})

// #383 — Auto-deny alert: when the risk engine slams the door without
// asking the user, fire a fire-and-forget channel notification so the
// user knows their guardian actually caught something.
function deniedEvent(
  overrides: Partial<ForemanEventMap['request:decided']> = {},
): ForemanEventMap['request:decided'] {
  return {
    requestId: 'r-deny-1',
    sourceAgent: 'openclaw',
    targetAgent: undefined,
    targetTool: 'read_file',
    args: { path: '.env' },
    decision: 'denied',
    decidedBy: 'policy:secret_path',
    riskScore: 80,
    riskReasons: ['secret_path', 'workspace_root'],
    riskFactors: [],
    riskBucket: 'high',
    llmVerification: null,
    securityReport: null,
    durationMs: 3800,
    createdAt: 0,
    decidedAt: 0,
    ...overrides,
  }
}

describe('NotificationBridge — bus.on(request:decided) → risk_deny alert (#383)', () => {
  let bus: EventBus<ForemanEventMap>
  let channel: FakeChannel
  let bridge: NotificationBridge
  let sqlite: Database.Database

  beforeEach(() => {
    const handle = createInMemoryDb()
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    channel = new FakeChannel('telegram')
    const service = new NotificationService({
      db: handle.db,
      config: configWithTelegram(),
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })
    bridge = new NotificationBridge(service, { bus })
  })

  afterEach(async () => {
    await bridge.stop()
    sqlite.close()
  })

  it('sends a risk_deny notification when an auto-deny lands', async () => {
    await bridge.start()
    bus.emit('request:decided', deniedEvent())
    await tick()
    expect(channel.sendCalls).toHaveLength(1)
    expect(channel.sendCalls[0]!.level).toBe('risk_deny')
    expect(channel.sendCalls[0]!.title).toContain('openclaw')
    expect(channel.sendCalls[0]!.body).toContain('secret_path')
  })

  it('skips when the decision is "allowed"', async () => {
    await bridge.start()
    bus.emit(
      'request:decided',
      deniedEvent({ decision: 'allowed', decidedBy: 'policy:safe' }),
    )
    await tick()
    expect(channel.sendCalls).toHaveLength(0)
  })

  it('skips user-driven denials (user already knows)', async () => {
    await bridge.start()
    bus.emit(
      'request:decided',
      deniedEvent({ decidedBy: 'user:telegram' }),
    )
    await tick()
    expect(channel.sendCalls).toHaveLength(0)
  })

  it('skips when source agent is muted', async () => {
    await bridge.stop()
    const service = new NotificationService({
      db: createInMemoryDb().db,
      config: configWithTelegram(),
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })
    bridge = new NotificationBridge(service, {
      bus,
      getState: () => ({ silencedUntil: null, mutedAgents: ['openclaw'] }),
    })
    await bridge.start()
    bus.emit('request:decided', deniedEvent())
    await tick()
    expect(channel.sendCalls).toHaveLength(0)
  })

  it('skips during a silence window', async () => {
    await bridge.stop()
    const service = new NotificationService({
      db: createInMemoryDb().db,
      config: configWithTelegram(),
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })
    bridge = new NotificationBridge(service, {
      bus,
      getState: () => ({
        silencedUntil: Date.now() + 60_000,
        mutedAgents: [],
      }),
    })
    await bridge.start()
    bus.emit('request:decided', deniedEvent())
    await tick()
    expect(channel.sendCalls).toHaveLength(0)
  })
})
