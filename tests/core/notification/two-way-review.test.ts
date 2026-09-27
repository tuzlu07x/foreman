import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { approvalSigner } from '../../../src/core/approval-token.js'
import { EventBus, type ForemanEventMap } from '../../../src/core/event-bus.js'
import { TelegramChannel, type TelegramFetch } from '../../../src/core/notification/channels/telegram.js'
import { NotificationBridge } from '../../../src/core/notification/notification-bridge.js'
import { NotificationService } from '../../../src/core/notification/notification-service.js'
import { defaultNotifyConfig } from '../../../src/core/notification/notify-config.js'
import {
  StaleDecisionError,
  type ChannelId,
  type ChannelMessageRef,
  type Notification,
  type NotificationChannel,
  type UserDecision,
} from '../../../src/core/notification/types.js'
import { isHumanSource } from '../../../src/core/org/guard.js'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'
import { settle, waitFor } from './fake-socket.js'

// Regression tests for the review of the two-way channels (#610 / #615).

class RecordingChannel implements NotificationChannel {
  readonly sent: Notification[] = []
  readonly edits: Array<{ ref: string; body: string; final: boolean }> = []
  handler: ((d: UserDecision) => Promise<void>) | null = null
  constructor(readonly id: ChannelId) {}
  async isReady() {
    return true
  }
  async send(n: Notification): Promise<ChannelMessageRef> {
    this.sent.push(n)
    return { channelMessageId: `${this.id}-${this.sent.length}` }
  }
  async updateMessage(ref: ChannelMessageRef, body: string, opts: { final?: boolean } = {}) {
    this.edits.push({ ref: ref.channelMessageId, body, final: opts.final === true })
  }
  async listen(onDecision: (d: UserDecision) => Promise<void>) {
    this.handler = onDecision
  }
  async shutdown() {}
}

const request = (requestId: string): ForemanEventMap['approval:requested'] => ({
  requestId,
  sourceAgent: 'codex',
  targetTool: 'shell_exec',
  args: { command: 'ls' },
  riskScore: 70,
  riskReasons: ['shell'],
  riskFactors: [],
  riskBucket: 'high',
  llmVerification: null,
  securityReport: null,
})

const tap = (requestId: string, decision: UserDecision['decision'], channel: ChannelId): UserDecision => ({
  notificationId: '',
  requestId,
  decision,
  decidedBy: `${channel}:U1`,
  decidedAt: Date.now(),
  channel,
})

describe('notification bridge with several two-way channels', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let slack: RecordingChannel
  let discord: RecordingChannel
  let bridge: NotificationBridge
  let resolved: ForemanEventMap['approval:resolved'][]
  let audit: unknown[]

  beforeEach(async () => {
    ;({ db, sqlite } = createInMemoryDb())
    bus = new EventBus<ForemanEventMap>()
    slack = new RecordingChannel('slack')
    discord = new RecordingChannel('discord')
    const config = defaultNotifyConfig()
    config.channels.slack = { enabled: true }
    config.channels.discord = { enabled: true }
    config.routing.critical = { channels: ['slack', 'discord'], timeout_seconds: 300, default_action: 'deny' }
    config.routing.warning = { channels: ['slack', 'discord'], timeout_seconds: 0, default_action: 'deny' }
    const channels = new Map<ChannelId, NotificationChannel>([
      ['slack', slack],
      ['discord', discord],
    ])
    audit = []
    bridge = new NotificationBridge(new NotificationService({ db, config, channels }), {
      bus,
      onChannelDecision: (info) => audit.push(info),
    })
    await bridge.start()
    resolved = []
    bus.on('approval:resolved', (e) => resolved.push(e))
  })
  afterEach(async () => {
    await bridge.stop()
    sqlite.close()
  })

  it('sends to every routed channel and removes the buttons on each when decided', async () => {
    bus.emit('approval:requested', request('req-1'))
    await waitFor(() => slack.sent.length === 1 && discord.sent.length === 1)
    await slack.handler!(tap('req-1', 'allow', 'slack'))
    await waitFor(() => slack.edits.some((e) => e.final) && discord.edits.some((e) => e.final))
    expect(resolved.map((r) => [r.requestId, r.decision, r.via])).toEqual([['req-1', 'allowed', 'slack']])
  })

  it('lets exactly one of two near-simultaneous taps count', async () => {
    bus.emit('approval:requested', request('req-2'))
    await waitFor(() => slack.sent.length === 1 && discord.sent.length === 1)
    const first = slack.handler!(tap('req-2', 'allow', 'slack'))
    const second = discord.handler!(tap('req-2', 'deny', 'discord'))
    await first
    await expect(second).rejects.toBeInstanceOf(StaleDecisionError)
    await settle()
    expect(resolved.map((r) => r.decision)).toEqual(['allowed'])
  })

  it('records who decided on which channel for the audit log', async () => {
    bus.emit('approval:requested', request('req-3'))
    await waitFor(() => slack.sent.length === 1)
    await slack.handler!(tap('req-3', 'deny_always', 'slack'))
    expect(audit).toEqual([{ requestId: 'req-3', channel: 'slack', decidedBy: 'slack:U1', decision: 'deny_always' }])
  })
})

describe('Telegram edits keep the buttons until the outcome', () => {
  it('re-sends the keyboard on a countdown edit and clears it on the final one', async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = []
    const fetchImpl: TelegramFetch = async (url, init) => {
      const method = /\/(\w+)$/.exec(url)![1]!
      calls.push({ method, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 9, chat: { id: 1 } } }),
        text: async () => '',
      }
    }
    const channel = new TelegramChannel({ botToken: 'T', chatId: '1', fetchImpl, signApproval: approvalSigner(randomBytes(32)) })
    const ref = await channel.send({
      id: 'n-1',
      level: 'critical',
      requestId: 'req-9',
      title: 'Approval needed',
      body: 'codex wants shell_exec\n⏱ 5m left',
      actions: [
        { id: 'allow', label: 'Allow' },
        { id: 'deny', label: 'Deny' },
      ],
      agentBlocking: true,
    })
    const keyboard = calls[0]!.body.reply_markup
    expect(keyboard).toBeDefined()
    await channel.updateMessage(ref, 'codex wants shell_exec\n⏱ 4m left')
    expect(calls[1]!.body.reply_markup).toEqual(keyboard)
    await channel.updateMessage(ref, '✓ Allowed', { final: true })
    expect(calls[2]!.body.reply_markup).toEqual({ inline_keyboard: [] })
  })
})

describe('human source ids', () => {
  it('match however they are spaced or cased', () => {
    for (const id of [' slack', 'Telegram ', 'FOREMAN', 'tui']) expect(isHumanSource(id)).toBe(true)
    expect(isHumanSource('codex')).toBe(false)
  })
})
