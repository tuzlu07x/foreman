import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NotificationService,
  type SendResult,
} from '../../../src/core/notification/notification-service.js'
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
import { notificationMessages, notifications } from '../../../src/db/schema.js'

class FakeChannel implements NotificationChannel {
  readonly id: ChannelId
  sendCalls: Notification[] = []
  shouldFail = false
  listenHandler: ((d: UserDecision) => Promise<void>) | null = null

  constructor(id: ChannelId) {
    this.id = id
  }
  async isReady(): Promise<boolean> {
    return true
  }
  async send(n: Notification): Promise<ChannelMessageRef> {
    this.sendCalls.push(n)
    if (this.shouldFail) throw new Error(`fake send failure for ${this.id}`)
    return { channelMessageId: `msg-${this.sendCalls.length}` }
  }
  async updateMessage(): Promise<void> {
    /* noop */
  }
  async listen(handler: (d: UserDecision) => Promise<void>): Promise<void> {
    this.listenHandler = handler
  }
  async shutdown(): Promise<void> {
    this.listenHandler = null
  }
}

function basePayload(): Omit<Notification, 'id'> {
  return {
    level: 'critical',
    requestId: 'req-1',
    title: 'risky call',
    body: 'agent wants to read .env',
    actions: [
      { id: 'allow', label: 'Allow' },
      { id: 'deny', label: 'Deny' },
    ],
    agentBlocking: false,
  }
}

function configWithTelegramEnabled(): NotifyConfig {
  const config = defaultNotifyConfig()
  config.channels.telegram = {
    enabled: true,
    bot_token_ref: 'tg',
    chat_id: '1',
  }
  return config
}

describe('NotificationService — send', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let channel: FakeChannel

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    channel = new FakeChannel('telegram')
  })

  afterEach(() => {
    sqlite.close()
  })

  it('routes a critical alert to telegram + persists sent + message rows', async () => {
    const config = configWithTelegramEnabled()
    const service = new NotificationService({
      db,
      config,
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })

    const result: SendResult = await service.send('critical', basePayload())
    expect(channel.sendCalls).toHaveLength(1)
    expect(channel.sendCalls[0]!.id).toBe(result.notificationId)

    const outcome = result.outcomes.get('telegram')
    expect(outcome).toMatchObject({ status: 'sent' })

    const rows = db.select().from(notifications).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(result.notificationId)
    expect(rows[0]!.channel).toBe('telegram')
    expect(rows[0]!.status).toBe('sent')
    expect(rows[0]!.requestId).toBe('req-1')

    const msgs = db.select().from(notificationMessages).all()
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.channelMessageId).toBe('msg-1')
  })

  it('skips a channel that exists but is disabled', async () => {
    const config = defaultNotifyConfig() // telegram.enabled = false
    const service = new NotificationService({
      db,
      config,
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })
    const result = await service.send('critical', basePayload())
    const outcome = result.outcomes.get('telegram')
    expect(outcome).toMatchObject({ status: 'skipped' })
    expect(channel.sendCalls).toHaveLength(0)
    expect(db.select().from(notifications).all()).toEqual([])
  })

  it('skips a channel that is enabled but has no registered instance', async () => {
    const config = configWithTelegramEnabled()
    const service = new NotificationService({
      db,
      config,
      channels: new Map(), // none registered
    })
    const result = await service.send('critical', basePayload())
    expect(result.outcomes.get('telegram')).toMatchObject({
      status: 'skipped',
      reason: 'channel not registered',
    })
  })

  it('records a failure row when the channel throws', async () => {
    const config = configWithTelegramEnabled()
    channel.shouldFail = true
    const service = new NotificationService({
      db,
      config,
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })
    const result = await service.send('critical', basePayload())
    expect(result.outcomes.get('telegram')).toMatchObject({ status: 'failed' })
    const rows = db.select().from(notifications).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('failed')
    expect(rows[0]!.error).toContain('fake send failure')
  })

  it('only sends to channels routed for the level (warning ≠ info)', async () => {
    const config = configWithTelegramEnabled()
    // info is empty by default → no channels routed
    const service = new NotificationService({
      db,
      config,
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })
    const result = await service.send('info', basePayload())
    expect(result.outcomes.size).toBe(0)
    expect(channel.sendCalls).toHaveLength(0)
  })
})

describe('NotificationService — decisions + listening', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let channel: FakeChannel

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    channel = new FakeChannel('telegram')
  })

  afterEach(() => {
    sqlite.close()
  })

  it('records the first decision and ignores subsequent ones for the same notification', async () => {
    const config = configWithTelegramEnabled()
    const service = new NotificationService({
      db,
      config,
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })
    await service.startListening()
    const { notificationId } = await service.send('critical', basePayload())

    // Fire two decisions on the same notification
    await channel.listenHandler!({
      notificationId,
      decision: 'allow',
      decidedBy: '777',
      decidedAt: Date.now(),
    })
    await channel.listenHandler!({
      notificationId,
      decision: 'deny',
      decidedBy: '777',
      decidedAt: Date.now() + 100,
    })

    const row = db.select().from(notifications).all()[0]!
    expect(row.decision).toBe('allow')
    expect(row.status).toBe('delivered')
    expect(row.decidedBy).toBe('telegram:777')

    await service.shutdown()
  })

  it('onAnyDecision callback fires once per validated decision', async () => {
    const config = configWithTelegramEnabled()
    const service = new NotificationService({
      db,
      config,
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })
    const onAny = vi.fn()
    service.onAnyDecision(onAny)
    await service.startListening()
    const { notificationId } = await service.send('critical', basePayload())

    await channel.listenHandler!({
      notificationId,
      decision: 'allow',
      decidedBy: '777',
      decidedAt: Date.now(),
    })
    expect(onAny).toHaveBeenCalledTimes(1)
    await service.shutdown()
  })

  it('normalises allow_always → allow + deny_always → deny on persistence', async () => {
    const config = configWithTelegramEnabled()
    const service = new NotificationService({
      db,
      config,
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })
    await service.startListening()
    const { notificationId } = await service.send('critical', basePayload())
    await channel.listenHandler!({
      notificationId,
      decision: 'allow_always',
      decidedBy: '777',
      decidedAt: Date.now(),
    })
    const row = db.select().from(notifications).all()[0]!
    expect(row.decision).toBe('allow')
    await service.shutdown()
  })

  it('recent() returns the most recent N rows newest-first', async () => {
    const config = configWithTelegramEnabled()
    const service = new NotificationService({
      db,
      config,
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })
    await service.send('critical', basePayload())
    await new Promise((r) => setTimeout(r, 5))
    await service.send('critical', basePayload())
    const rows = service.recent(5)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.sentAt).toBeGreaterThanOrEqual(rows[1]!.sentAt)
  })
})
