import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { approvalSigner } from '../../../src/core/approval-token.js'
import { TelegramChannel, type TelegramFetch } from '../../../src/core/notification/channels/telegram.js'
import type { Notification, UserDecision } from '../../../src/core/notification/types.js'

// =============================================================================
// #610 — Dedicated approval bot: approvals go through a bot only Foreman
// holds and polls, so no chat agent ever sees an approval button.
// =============================================================================

const MAIN = 'MAIN_TOKEN'
const APPROVAL = 'APPROVAL_TOKEN'
const CHAT = '424242'
const sign = approvalSigner(randomBytes(32))

interface Call {
  token: string
  method: string
  body: Record<string, unknown>
}

function harness(updates: unknown[][], status: number[] = []) {
  const calls: Call[] = []
  const queue = [...updates]
  const statuses = [...status]
  const fetchImpl: TelegramFetch = async (url, init) => {
    const m = /\/bot([^/]+)\/(\w+)$/.exec(url)!
    const call = { token: m[1]!, method: m[2]!, body: JSON.parse(String(init?.body ?? '{}')) }
    calls.push(call)
    if (call.method === 'getUpdates') {
      const code = statuses.shift() ?? 200
      if (code !== 200) return { ok: false, status: code, json: async () => ({}), text: async () => '' }
      const batch = queue.shift()
      if (!batch) await new Promise((r) => setTimeout(r, 20))
      return { ok: true, status: 200, json: async () => ({ ok: true, result: batch ?? [] }), text: async () => '' }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 7, chat: { id: Number(CHAT) } } }),
      text: async () => '',
    }
  }
  const warnings: string[] = []
  const channel = new TelegramChannel({
    botToken: MAIN,
    chatId: CHAT,
    fetchImpl,
    signApproval: sign,
    approvalBotToken: APPROVAL,
    onWarning: (w) => warnings.push(w),
    pollTimeoutSeconds: 0,
    pollBackoffMs: 10,
    minPollIntervalMs: 10,
  })
  return { channel, calls, warnings }
}

const approval: Notification = {
  id: 'notif-1',
  level: 'critical',
  requestId: 'req-1',
  title: 'hermes wants to read .env',
  body: 'secret_path',
  actions: [
    { id: 'allow', label: 'Allow once', style: 'primary' },
    { id: 'deny', label: 'Deny', style: 'danger' },
    { id: 'allow_always', label: 'Always allow' },
    { id: 'block_secret_path', label: 'Block pattern', intent: 'custom', payload: { action: 'add-deny-rule' } },
  ],
  agentBlocking: true,
}

const tap = (updateId: number, data: string, fromId = CHAT, chatId = CHAT) => ({
  update_id: updateId,
  callback_query: {
    id: `cb-${updateId}`,
    from: { id: Number(fromId) },
    data,
    message: { message_id: 7, chat: { id: Number(chatId) } },
  },
})

const settle = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('Telegram approval bot (#610)', () => {
  let active: TelegramChannel | null = null
  afterEach(async () => {
    await active?.shutdown()
    active = null
  })

  it('sends approvals through the approval bot, with no typed commands and no custom actions', async () => {
    const { channel, calls } = harness([])
    const ref = await channel.send(approval)
    expect(ref.channelMessageId).toBe('a:7')
    const sent = calls.find((c) => c.method === 'sendMessage')!
    expect(sent.token).toBe(APPROVAL)
    expect(String(sent.body.text)).not.toContain('/deny')
    const data = (sent.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard
      .flat()
      .map((b) => b.callback_data)
    expect(data).toEqual([
      `fa:allow:req-1.${sign('req-1', 'allow')}`,
      `fa:deny:req-1.${sign('req-1', 'deny')}`,
      `fa:allow_always:req-1.${sign('req-1', 'allow_always')}`,
    ])
    // Edits go through the bot that sent the message.
    await channel.updateMessage(ref, 'Decided')
    expect(calls.at(-1)).toMatchObject({ token: APPROVAL, method: 'editMessageText', body: { message_id: 7 } })
  })

  it('keeps everything else on the main bot', async () => {
    const { channel, calls } = harness([])
    const ref = await channel.send({ ...approval, actions: [], title: 'Budget 80% spent' })
    expect(ref.channelMessageId).toBe('7')
    expect(calls[0]!.token).toBe(MAIN)
  })

  it("turns the owner's tap into a decision for that request, then removes the buttons", async () => {
    const token = `req-1.${sign('req-1', 'allow_always')}`
    const { channel, calls } = harness([[tap(10, `fa:allow_always:${token}`)]])
    active = channel
    const decisions: UserDecision[] = []
    await channel.listen(async (d) => {
      decisions.push(d)
    })
    await settle()
    expect(decisions).toMatchObject([
      { requestId: 'req-1', decision: 'allow_always', decidedBy: `telegram:${CHAT}`, channel: 'telegram' },
    ])
    expect(calls.filter((c) => c.method === 'getUpdates').every((c) => c.token === APPROVAL)).toBe(true)
    expect(calls.find((c) => c.method === 'answerCallbackQuery')!.body.text).toBe('Allowed ✓')
    expect(calls.find((c) => c.method === 'editMessageReplyMarkup')!.body).toMatchObject({
      reply_markup: { inline_keyboard: [] },
    })
    // The next poll acknowledges the update.
    expect(calls.filter((c) => c.method === 'getUpdates').some((c) => c.body.offset === 11)).toBe(true)
  })

  it('ignores taps from anyone else, forged tags, and a Deny tag replayed as Allow', async () => {
    const good = `req-1.${sign('req-1', 'allow')}`
    const { channel, calls } = harness([
      [
        tap(1, `fa:allow:${good}`, '999'), // someone else
        tap(2, `fa:allow:${good}`, CHAT, '-100500'), // right user, wrong chat (a group)
        tap(3, 'fa:allow:req-1.AAAAAAAAAA'), // forged tag
        tap(4, `fa:allow:req-1.${sign('req-1', 'deny')}`), // deny tag, allow action
        tap(5, `fa:block_secret_path:req-1.${sign('req-1', 'block_secret_path')}`), // not handled here
      ],
    ])
    active = channel
    const decisions: UserDecision[] = []
    await channel.listen(async (d) => {
      decisions.push(d)
    })
    await settle()
    expect(decisions).toEqual([])
    expect(calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.body.text)).toEqual([
      'Not allowed.',
      'Not allowed.',
      'This button is no longer valid.',
      'This button is no longer valid.',
      'Unsupported button.',
    ])
  })

  it('warns when another process polls the same bot, and stops on a rejected token', async () => {
    const { channel, warnings } = harness([], [409, 401])
    active = channel
    await channel.listen(async () => {})
    await settle(80)
    expect(warnings[0]).toContain('Another process is polling')
    await channel.shutdown()
    const second = harness([], [401])
    await second.channel.listen(async () => {})
    await settle(60)
    expect(second.warnings).toEqual(['Telegram rejected the approval bot token; approvals fall back to the TUI.'])
  })

  it('without an approval bot, listen() stays a no-op (relay mode)', async () => {
    const calls: string[] = []
    const channel = new TelegramChannel({
      botToken: MAIN,
      chatId: CHAT,
      fetchImpl: async (url) => {
        calls.push(url)
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
      },
    })
    await channel.listen(async () => {})
    await settle(40)
    expect(calls).toEqual([])
  })
})

describe('approval bot end to end: agent call → Telegram tap → agent unblocked', () => {
  it('a tap on the approval bot allows the waiting call, audited as user:telegram', async () => {
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
    const policy = new PolicyEngine(db, bus)
    const mediator = new MediatorService({
      registry,
      policy,
      risk: new RiskScorer(db),
      approval: new BusApprovalService({ bus, timeoutMs: 5_000 }),
      bus,
    })

    // Telegram double: the approval bot's inbox is filled by the test.
    const pendingUpdates: unknown[] = []
    const sent: Array<{ token: string; body: Record<string, unknown> }> = []
    const fetchImpl: TelegramFetch = async (url, init) => {
      const [, token, method] = /\/bot([^/]+)\/(\w+)$/.exec(url)!
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      if (method === 'getUpdates') {
        const batch = pendingUpdates.splice(0)
        if (batch.length === 0) await new Promise((r) => setTimeout(r, 15))
        return { ok: true, status: 200, json: async () => ({ ok: true, result: batch }), text: async () => '' }
      }
      if (method === 'sendMessage') sent.push({ token: token!, body })
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1, chat: { id: Number(CHAT) } } }),
        text: async () => '',
      }
    }
    const channel = new TelegramChannel({
      botToken: MAIN,
      chatId: CHAT,
      fetchImpl,
      signApproval: sign,
      approvalBotToken: APPROVAL,
      pollTimeoutSeconds: 0,
      minPollIntervalMs: 10,
    })
    const config = defaultNotifyConfig()
    config.channels.telegram = { enabled: true, bot_token_ref: 'tg', approval_bot_token_ref: 'tga', chat_id: CHAT }
    const bridge = new NotificationBridge(new NotificationService({ db, config, channels: new Map([['telegram', channel]]) }), {
      bus,
    })
    await bridge.start()
    try {
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
      for (let i = 0; i < 50 && sent.length === 0; i++) await settle(10)
      expect(sent[0]!.token).toBe(APPROVAL)
      const allowButton = (sent[0]!.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> })
        .inline_keyboard.flat()
        .find((b) => b.callback_data.startsWith('fa:allow:'))!
      pendingUpdates.push(tap(1, allowButton.callback_data))
      const result = await call
      expect(result.decision).toBe('allowed')
      expect(result.decidedBy).toBe('user:telegram')
    } finally {
      await bridge.stop()
      sqlite.close()
    }
  })
})
