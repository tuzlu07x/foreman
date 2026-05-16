import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  escapeMd,
  TelegramChannel,
  type TelegramFetch,
} from '../../../src/core/notification/channels/telegram.js'
import type { Notification, UserDecision } from '../../../src/core/notification/types.js'

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
    id: 'notif-1',
    level: 'critical',
    requestId: 'req-99',
    title: 'Hermes wants to read .env',
    body: 'Phishing attempt detected. Tap to decide.',
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

describe('TelegramChannel — send', () => {
  let channel: TelegramChannel
  let calls: Array<{ url: string; body: unknown }>

  beforeEach(() => {
    const f = makeFetch([
      { body: { ok: true, result: { message_id: 42, chat: { id: 12345 } } } },
    ])
    calls = f.calls
    channel = new TelegramChannel({
      botToken: 'TEST_TOKEN',
      chatId: '12345',
      fetchImpl: f.fetchImpl,
    })
  })

  it('hits the Telegram sendMessage endpoint with the correct body', async () => {
    const ref = await channel.send(makeNotification())
    expect(ref.channelMessageId).toBe('42')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/botTEST_TOKEN/sendMessage')
    const body = calls[0]!.body as Record<string, unknown>
    expect(body.chat_id).toBe('12345')
    expect(body.parse_mode).toBe('MarkdownV2')
  })

  it('renders the inline keyboard with one button per action', async () => {
    await channel.send(makeNotification())
    const body = calls[0]!.body as {
      reply_markup: {
        inline_keyboard: { text: string; callback_data: string }[][]
      }
    }
    const row = body.reply_markup.inline_keyboard[0]!
    expect(row).toHaveLength(2)
    expect(row[0]!.text).toContain('Allow')
    expect(row[0]!.callback_data).toBe('notif-1:allow')
    expect(row[1]!.text).toContain('Deny')
    expect(row[1]!.callback_data).toBe('notif-1:deny')
  })

  it('emits an empty keyboard when actions list is empty (info-only alert)', async () => {
    await channel.send(makeNotification({ actions: [] }))
    const body = calls[0]!.body as {
      reply_markup: { inline_keyboard: unknown[] }
    }
    expect(body.reply_markup.inline_keyboard).toEqual([])
  })

  it('escapes MarkdownV2 reserved chars in title + body', async () => {
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

describe('TelegramChannel — listen + callback validation', () => {
  it('routes a valid callback to onDecision and rejects other chat_ids', async () => {
    const f = makeFetch([
      // 1st poll: one callback from the configured chat_id
      {
        body: {
          ok: true,
          result: [
            {
              update_id: 100,
              callback_query: {
                id: 'cb-1',
                from: { id: 777 },
                data: 'notif-1:allow',
                message: { message_id: 42, chat: { id: 12345 } },
              },
            },
          ],
        },
      },
      // answerCallbackQuery response
      { body: { ok: true } },
      // 2nd poll: callback from a different chat (impersonation attempt)
      {
        body: {
          ok: true,
          result: [
            {
              update_id: 101,
              callback_query: {
                id: 'cb-2',
                from: { id: 888 },
                data: 'notif-1:deny',
                message: { message_id: 42, chat: { id: 99999 } },
              },
            },
          ],
        },
      },
      // send response (initial)
      { body: { ok: true, result: { message_id: 42, chat: { id: 12345 } } } },
    ])
    const sendResponse = f.fetchImpl
    // Re-seed: first the send, then polls
    const f2 = makeFetch([
      { body: { ok: true, result: { message_id: 42, chat: { id: 12345 } } } },
      {
        body: {
          ok: true,
          result: [
            {
              update_id: 100,
              callback_query: {
                id: 'cb-1',
                from: { id: 777 },
                data: 'notif-1:allow',
                message: { message_id: 42, chat: { id: 12345 } },
              },
            },
          ],
        },
      },
      { body: { ok: true } },
      {
        body: {
          ok: true,
          result: [
            {
              update_id: 101,
              callback_query: {
                id: 'cb-2',
                from: { id: 888 },
                data: 'notif-1:deny',
                message: { message_id: 42, chat: { id: 99999 } },
              },
            },
          ],
        },
      },
    ])
    void sendResponse

    const channel = new TelegramChannel({
      botToken: 'X',
      chatId: '12345',
      fetchImpl: f2.fetchImpl,
      maxPolls: 2,
    })

    await channel.send(makeNotification())

    const decisions: UserDecision[] = []
    await channel.listen(async (d) => {
      decisions.push(d)
    })

    // Wait for the poll loop to complete its 2 iterations
    await new Promise((r) => setTimeout(r, 50))
    await channel.shutdown()

    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.notificationId).toBe('notif-1')
    expect(decisions[0]!.decision).toBe('allow')
    expect(decisions[0]!.decidedBy).toBe('777')
  })

  it('drops callbacks whose data targets an unknown notification', async () => {
    const f = makeFetch([
      { body: { ok: true, result: { message_id: 42, chat: { id: 12345 } } } },
      {
        body: {
          ok: true,
          result: [
            {
              update_id: 1,
              callback_query: {
                id: 'cb-3',
                from: { id: 777 },
                data: 'unknown-notif:allow',
                message: { message_id: 99, chat: { id: 12345 } },
              },
            },
          ],
        },
      },
    ])
    const channel = new TelegramChannel({
      botToken: 'X',
      chatId: '12345',
      fetchImpl: f.fetchImpl,
      maxPolls: 1,
    })
    await channel.send(makeNotification())
    const decisions: UserDecision[] = []
    await channel.listen(async (d) => {
      decisions.push(d)
    })
    await new Promise((r) => setTimeout(r, 30))
    await channel.shutdown()
    expect(decisions).toEqual([])
  })

  it('drops callbacks with an unknown action verb', async () => {
    const f = makeFetch([
      { body: { ok: true, result: { message_id: 42, chat: { id: 12345 } } } },
      {
        body: {
          ok: true,
          result: [
            {
              update_id: 1,
              callback_query: {
                id: 'cb-x',
                from: { id: 777 },
                data: 'notif-1:format_drive', // not in ACTION_IDS
                message: { message_id: 42, chat: { id: 12345 } },
              },
            },
          ],
        },
      },
    ])
    const channel = new TelegramChannel({
      botToken: 'X',
      chatId: '12345',
      fetchImpl: f.fetchImpl,
      maxPolls: 1,
    })
    await channel.send(makeNotification())
    const decisions: UserDecision[] = []
    await channel.listen(async (d) => {
      decisions.push(d)
    })
    await new Promise((r) => setTimeout(r, 30))
    await channel.shutdown()
    expect(decisions).toEqual([])
  })
})

describe('TelegramChannel — isReady + updateMessage + shutdown', () => {
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

  it('shutdown stops the poll loop even when no decisions arrive', async () => {
    const f = makeFetch(
      Array.from({ length: 10 }, () => ({ body: { ok: true, result: [] } })),
    )
    const ch = new TelegramChannel({
      botToken: 'X',
      chatId: '1',
      fetchImpl: f.fetchImpl,
      maxPolls: 50,
    })
    await ch.listen(vi.fn())
    await ch.shutdown()
    // shutdown returns once the poll loop sees stopRequested.
  })
})
