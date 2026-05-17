import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BudgetAlertBridge,
  formatBudgetAlert,
} from '../../../src/core/llm/budget-alert-bridge.js'
import {
  EventBus,
  type ForemanEventMap,
} from '../../../src/core/event-bus.js'
import { NotificationService } from '../../../src/core/notification/notification-service.js'
import { defaultNotifyConfig } from '../../../src/core/notification/notify-config.js'
import type {
  ChannelMessageRef,
  Notification,
  NotificationChannel,
  UserDecision,
} from '../../../src/core/notification/types.js'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'

class FakeChannel implements NotificationChannel {
  id = 'telegram' as const
  sent: Notification[] = []
  async isReady(): Promise<boolean> {
    return true
  }
  async send(n: Notification): Promise<ChannelMessageRef> {
    this.sent.push(n)
    return { channelMessageId: `m-${this.sent.length}` }
  }
  async updateMessage(): Promise<void> {}
  async listen(_h: (d: UserDecision) => Promise<void>): Promise<void> {}
  async shutdown(): Promise<void> {}
}

describe('formatBudgetAlert', () => {
  it('renders the threshold variant with %, $, and days', () => {
    const out = formatBudgetAlert({
      kind: 'threshold',
      spentUsd: 4.0,
      capUsd: 5.0,
      spentPct: 80,
      windowStart: 0,
      windowEnd: 0,
      daysUntilReset: 7,
    })
    expect(out.title).toContain('80% spent')
    expect(out.body).toContain('$4.00')
    expect(out.body).toContain('$5.00')
    expect(out.body).toContain('7 days')
  })

  it('renders the exhausted variant with paused-features framing', () => {
    const out = formatBudgetAlert({
      kind: 'exhausted',
      spentUsd: 5.2,
      capUsd: 5.0,
      spentPct: 104,
      windowStart: 0,
      windowEnd: 0,
      daysUntilReset: 1,
    })
    expect(out.title).toContain('exhausted')
    expect(out.body).toContain('paused')
    expect(out.body).toContain('1 day')
  })
})

describe('BudgetAlertBridge', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let channel: FakeChannel
  let service: NotificationService

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    channel = new FakeChannel()
    const config = defaultNotifyConfig()
    config.channels.telegram = { enabled: true }
    config.routing.budget_alert = {
      channels: ['telegram'],
      timeout_seconds: 0,
      default_action: 'deny',
    }
    service = new NotificationService({
      db,
      config,
      channels: new Map([['telegram', channel]]),
    })
  })

  afterEach(() => { sqlite.close() })

  it('dispatches a budget_alert notification when the bus event fires', async () => {
    const bridge = new BudgetAlertBridge({ bus, notify: service })
    bridge.start()
    bus.emit('llm:budget-alert', {
      kind: 'threshold',
      spentUsd: 4,
      capUsd: 5,
      spentPct: 80,
      windowStart: 0,
      windowEnd: 0,
      daysUntilReset: 7,
    })
    // give the async dispatch a microtask to flush
    await Promise.resolve()
    await Promise.resolve()
    expect(channel.sent).toHaveLength(1)
    expect(channel.sent[0]!.level).toBe('budget_alert')
    expect(channel.sent[0]!.title).toContain('80%')
  })

  it('stop() unsubscribes cleanly', async () => {
    const bridge = new BudgetAlertBridge({ bus, notify: service })
    bridge.start()
    bridge.stop()
    bus.emit('llm:budget-alert', {
      kind: 'exhausted',
      spentUsd: 6,
      capUsd: 5,
      spentPct: 120,
      windowStart: 0,
      windowEnd: 0,
      daysUntilReset: 0,
    })
    await Promise.resolve()
    expect(channel.sent).toHaveLength(0)
  })
})
