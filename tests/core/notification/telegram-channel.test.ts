import { describe, expect, it } from 'vitest'
import {
  escapeMd,
  TelegramChannel,
  type TelegramFetch,
} from '../../../src/core/notification/channels/telegram.js'
import type { Notification } from '../../../src/core/notification/types.js'

// =============================================================================
// #406 — TelegramChannel is outbound-only. Polling was removed because it
// fought the agent's own `getUpdates` consumer (Hermes / OpenClaw) for the
// same bot. Approval routing now happens via the `submit_approval` MCP tool.
// =============================================================================

interface MockResponse {
  status?: number
  body: unknown
}

function makeFetch(plan: MockResponse[]): {
  fetchImpl: TelegramFetch
  calls: Array<{ url: string; body: unknown }>
} {
  let cursor = 0
  const calls: Array<{ url: string; body: unknown }> = []
  const fetchImpl: TelegramFetch = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, body })
    const next = plan[cursor++] ?? { body: { ok: true } }
    return {
      ok: (next.status ?? 200) >= 200 && (next.status ?? 200) < 300,
      status: next.status ?? 200,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    }
  }
  return { fetchImpl, calls }
}

function makeNotification(
  overrides: Partial<Notification> = {},
): Notification {
  return {
    id: 'notif-abc123',
    level: 'critical',
    requestId: 'req-99',
    title: 'Hermes wants to read .env',
    body: 'Phishing pattern detected (.env file likely contains secrets).',
    actions: [
      { id: 'allow', label: 'Allow once', style: 'primary' },
      { id: 'deny', label: 'Deny', style: 'danger' },
    ],
    agentBlocking: true,
    ...overrides,
  }
}

describe('escapeMd', () => {
  it('escapes Telegram MarkdownV2 reserved characters', () => {
    expect(escapeMd('hello.world')).toBe('hello\\.world')
    expect(escapeMd('[link](url)')).toBe('\\[link\\]\\(url\\)')
    expect(escapeMd('a*b_c~d`e')).toBe('a\\*b\\_c\\~d\\`e')
  })

  it('passes regular text through unchanged', () => {
    expect(escapeMd('plain text')).toBe('plain text')
    expect(escapeMd('türkçe çıkış')).toBe('türkçe çıkış')
  })
})

describe('TelegramChannel — send (outbound only, #406)', () => {
  function setupChannel(): {
    channel: TelegramChannel
    calls: Array<{ url: string; body: unknown }>
  } {
    const f = makeFetch([
      { body: { ok: true, result: { message_id: 42, chat: { id: 12345 } } } },
    ])
    const channel = new TelegramChannel({
      botToken: 'TEST_TOKEN',
      chatId: '12345',
      fetchImpl: f.fetchImpl,
    })
    return { channel, calls: f.calls }
  }

  it('hits the Telegram sendMessage endpoint with the correct body', async () => {
    const { channel, calls } = setupChannel()
    const ref = await channel.send(makeNotification())
    expect(ref.channelMessageId).toBe('42')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/botTEST_TOKEN/sendMessage')
    const body = calls[0]!.body as Record<string, unknown>
    expect(body.chat_id).toBe('12345')
    expect(body.parse_mode).toBe('MarkdownV2')
  })

  it('embeds /approve <id> and /deny <id> slash commands in the body', async () => {
    const { channel, calls } = setupChannel()
    await channel.send(makeNotification())
    const body = calls[0]!.body as { text: string }
    expect(body.text).toContain('/approve notif-abc123')
    expect(body.text).toContain('/deny notif-abc123')
  })

  it('embeds /approve_remember and /deny_remember for allow_always / deny_always actions', async () => {
    const { channel, calls } = setupChannel()
    await channel.send(
      makeNotification({
        actions: [
          { id: 'allow', label: 'Allow once' },
          { id: 'allow_always', label: 'Allow + remember' },
          { id: 'deny', label: 'Deny' },
          { id: 'deny_always', label: 'Deny + remember' },
        ],
      }),
    )
    const body = calls[0]!.body as { text: string }
    expect(body.text).toContain('/approve notif-abc123')
    expect(body.text).toContain('/approve_remember notif-abc123')
    expect(body.text).toContain('/deny notif-abc123')
    expect(body.text).toContain('/deny_remember notif-abc123')
  })

  it('does NOT render a reply_markup field (no inline keyboard — Foreman never polls)', async () => {
    const { channel, calls } = setupChannel()
    await channel.send(makeNotification())
    const body = calls[0]!.body as Record<string, unknown>
    expect(body.reply_markup).toBeUndefined()
  })

  it('renders body only (no slash-command block) when actions is empty (info-only alert)', async () => {
    const { channel, calls } = setupChannel()
    await channel.send(makeNotification({ actions: [] }))
    const body = calls[0]!.body as { text: string }
    expect(body.text).not.toContain('/approve')
    expect(body.text).not.toContain('/deny')
    expect(body.text).toContain('Phishing pattern')
  })

  it('skips inspect actions in the command list (no slash command for inspect)', async () => {
    const { channel, calls } = setupChannel()
    await channel.send(
      makeNotification({
        actions: [
          { id: 'allow', label: 'Allow once' },
          { id: 'inspect', label: 'Inspect' },
          { id: 'deny', label: 'Deny' },
        ],
      }),
    )
    const body = calls[0]!.body as { text: string }
    expect(body.text).toContain('/approve notif-abc123')
    expect(body.text).toContain('/deny notif-abc123')
    expect(body.text).not.toContain('/inspect')
  })

  it('escapes MarkdownV2 reserved chars in title + body', async () => {
    const { channel, calls } = setupChannel()
    await channel.send(
      makeNotification({
        title: 'Hermes [risk] wants read_file(.env)',
        body: 'Sent to webhook.site/abc-123.',
      }),
    )
    const body = calls[0]!.body as { text: string }
    expect(body.text).toContain('\\[risk\\]')
    expect(body.text).toContain('read\\_file\\(\\.env\\)')
    expect(body.text).toContain('webhook\\.site/abc\\-123\\.')
  })

  it('throws TelegramApiError on a non-ok response body', async () => {
    const f = makeFetch([{ body: { ok: false, description: 'bad chat_id' } }])
    const ch = new TelegramChannel({
      botToken: 'X',
      chatId: '1',
      fetchImpl: f.fetchImpl,
    })
    await expect(ch.send(makeNotification())).rejects.toThrow(/bad chat_id/)
  })
})

describe('TelegramChannel — no polling (#406)', () => {
  it('listen() is a no-op — never calls getUpdates', async () => {
    const f = makeFetch([])
    const ch = new TelegramChannel({
      botToken: 'X',
      chatId: '1',
      fetchImpl: f.fetchImpl,
    })
    // The handler should never be invoked since the channel doesn't poll.
    let handlerCalls = 0
    await ch.listen(async () => {
      handlerCalls++
    })
    // Give any rogue polling loop a chance to fire — there should be none.
    await new Promise((r) => setTimeout(r, 30))
    expect(handlerCalls).toBe(0)
    expect(f.calls).toHaveLength(0)
  })

  it('shutdown() is a no-op (no polling loop to stop)', async () => {
    const f = makeFetch([])
    const ch = new TelegramChannel({
      botToken: 'X',
      chatId: '1',
      fetchImpl: f.fetchImpl,
    })
    await ch.shutdown() // must not throw, must not call fetch
    expect(f.calls).toHaveLength(0)
  })
})

describe('TelegramChannel — isReady + updateMessage', () => {
  it('isReady returns true when getMe is ok', async () => {
    const f = makeFetch([{ body: { ok: true, result: { id: 1 } } }])
    const ch = new TelegramChannel({
      botToken: 'X',
      chatId: '1',
      fetchImpl: f.fetchImpl,
    })
    expect(await ch.isReady()).toBe(true)
  })

  it('isReady returns false on a non-ok getMe', async () => {
    const f = makeFetch([{ body: { ok: false, description: 'Unauthorized' } }])
    const ch = new TelegramChannel({
      botToken: 'X',
      chatId: '1',
      fetchImpl: f.fetchImpl,
    })
    expect(await ch.isReady()).toBe(false)
  })

  it('updateMessage calls editMessageText with the encoded body', async () => {
    const f = makeFetch([{ body: { ok: true, result: true } }])
    const ch = new TelegramChannel({
      botToken: 'X',
      chatId: '1',
      fetchImpl: f.fetchImpl,
    })
    await ch.updateMessage({ channelMessageId: '7' }, 'Resolved at 14:18.')
    expect(f.calls[0]!.url).toContain('/editMessageText')
    const body = f.calls[0]!.body as { text: string; message_id: number }
    expect(body.message_id).toBe(7)
    expect(body.text).toBe('Resolved at 14:18\\.')
  })
})
