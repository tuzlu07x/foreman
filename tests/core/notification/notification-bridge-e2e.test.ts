import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BusApprovalService,
  type ApprovalDecision,
} from '../../../src/core/approval.js'
import { AuditLogger } from '../../../src/core/audit.js'
import { EventBus, type ForemanEventMap } from '../../../src/core/event-bus.js'
import { MediatorService } from '../../../src/core/mediator.js'
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
import { PolicyEngine } from '../../../src/core/policy-engine.js'
import { RegistryService } from '../../../src/core/registry.js'
import { RiskScorer } from '../../../src/core/risk-scorer.js'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'
import { requests } from '../../../src/db/schema.js'

// End-to-end: real mediator + risk + bus + approval + bridge + a mocked
// "Telegram" channel. We synthesise an `approval:requested` event by driving
// a risky tool call, observe that the bridge sends a notification, simulate
// a user tap on the channel, and confirm the agent's pending call returns
// with the user's decision.

class FakeChannel implements NotificationChannel {
  readonly id: ChannelId = 'telegram'
  sendCalls: Notification[] = []
  updateCalls: { ref: ChannelMessageRef; body: string }[] = []
  private listenHandler: ((d: UserDecision) => Promise<void>) | null = null
  async isReady(): Promise<boolean> {
    return true
  }
  async send(n: Notification): Promise<ChannelMessageRef> {
    this.sendCalls.push(n)
    return { channelMessageId: `tg-${this.sendCalls.length}` }
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
  /** Test-only: simulate a user tapping a button on this channel. */
  async simulateTap(d: UserDecision): Promise<void> {
    if (!this.listenHandler) throw new Error('listen() not called yet')
    await this.listenHandler(d)
  }
}

function configWithTelegram(): NotifyConfig {
  const c = defaultNotifyConfig()
  c.channels.telegram = { enabled: true, bot_token_ref: 'tg', chat_id: '1' }
  return c
}

describe('NotificationBridge end-to-end (#235 C11a-2 acceptance)', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let audit: AuditLogger
  let mediator: MediatorService
  let channel: FakeChannel
  let bridge: NotificationBridge

  beforeEach(async () => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    audit = new AuditLogger(db, bus)

    const registry = new RegistryService(db, bus)
    const policy = new PolicyEngine(db, bus)
    const risk = new RiskScorer(db, undefined, {
      bucketOverrides: () => policy.getBucketOverrides(),
    })
    // BusApprovalService: in-process, waits for approval:resolved on the bus.
    const approval = new BusApprovalService({ bus, timeoutMs: 2_000 })

    mediator = new MediatorService({ registry, policy, risk, approval, bus })

    channel = new FakeChannel()
    const service = new NotificationService({
      db,
      config: configWithTelegram(),
      channels: new Map<ChannelId, NotificationChannel>([['telegram', channel]]),
    })
    bridge = new NotificationBridge(service, { bus })
    await bridge.start()
  })

  afterEach(async () => {
    await bridge.stop()
    audit.dispose()
    sqlite.close()
  })

  it('Telegram tap unblocks the agent: critical .env read → bridge sends → user denies → mediator returns denied', async () => {
    // Kick off a risky call. The mediator will see the .env factor and
    // call approval.request(); BusApprovalService waits for the bus event.
    const pending = mediator.handleRequest({
      requestId: 'r-e2e-1',
      sourceAgent: 'hermes',
      targetAgent: 'claude-code',
      targetTool: 'read_file',
      message: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '.env' } },
      } as never,
      sessionId: 'sess-1',
    })

    // Wait for the bridge to send the notification before we simulate the tap.
    await new Promise((r) => setTimeout(r, 30))
    expect(channel.sendCalls).toHaveLength(1)
    const notificationId = channel.sendCalls[0]!.id

    // Simulate a user tapping "Deny" on Telegram.
    await channel.simulateTap({
      notificationId,
      decision: 'deny',
      decidedBy: '7777',
      decidedAt: Date.now(),
    })

    const result = await pending
    expect(result.decision).toBe('denied')
    expect(result.decidedBy).toBe('user')

    // Audit row is persisted with the denial.
    audit.flush()
    const row = db.select().from(requests).all().find((r) => r.id === 'r-e2e-1')!
    expect(row.decision).toBe('denied')
  })

  it('OOB allow_always tap → agent allowed AND policy.remember called', async () => {
    const pending = mediator.handleRequest({
      requestId: 'r-e2e-2',
      sourceAgent: 'hermes',
      targetAgent: 'claude-code',
      targetTool: 'read_file',
      message: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '.env' } },
      } as never,
      sessionId: 'sess-1',
    })
    await new Promise((r) => setTimeout(r, 30))
    const notificationId = channel.sendCalls[0]!.id
    await channel.simulateTap({
      notificationId,
      decision: 'allow_always',
      decidedBy: '7777',
      decidedAt: Date.now(),
    })
    const result = await pending
    expect(result.decision).toBe('allowed')
    // The "remember" flag in approval:resolved triggers policy.remember()
    // inside the mediator → the audit + policy table should reflect it.
    audit.flush()
    const row = db.select().from(requests).all().find((r) => r.id === 'r-e2e-2')!
    expect(row.decision).toBe('allowed')
  })

  it('TUI decision wins the race → channel sees an "elsewhere" updateMessage', async () => {
    const pending = mediator.handleRequest({
      requestId: 'r-race-1',
      sourceAgent: 'hermes',
      targetAgent: 'claude-code',
      targetTool: 'read_file',
      message: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '.env' } },
      } as never,
      sessionId: 'sess-1',
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(channel.sendCalls).toHaveLength(1)

    // TUI fires the resolution first (simulating the user tapping in the modal).
    bus.emit('approval:resolved', {
      requestId: 'r-race-1',
      decision: 'denied',
      resolvedBy: 'user',
    })
    const result = await pending
    expect(result.decision).toBe('denied')

    // Bridge should have updated the channel message so the user knows it's
    // already resolved on the other path.
    await new Promise((r) => setTimeout(r, 10))
    expect(channel.updateCalls).toHaveLength(1)
    expect(channel.updateCalls[0]!.body).toContain('Denied')
    expect(channel.updateCalls[0]!.body).toContain('elsewhere')

    // A late OOB tap should now be a no-op (notification already resolved).
    const notificationId = channel.sendCalls[0]!.id
    await channel.simulateTap({
      notificationId,
      decision: 'allow',
      decidedBy: '7777',
      decidedAt: Date.now(),
    })
    // The pending promise already resolved — late tap doesn't double-decide.
  })
})
