import { describe, expect, it } from 'vitest'
import {
  escapeMd,
  renderInlineKeyboard,
  TelegramChannel,
  type TelegramFetch,
} from '../../../src/core/notification/channels/telegram.js'
import {
  intentForActionId,
  type ChannelAction,
  type Notification,
} from '../../../src/core/notification/types.js'

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

  it('embeds /approve <id> and /deny <id> slash commands in the body — with the aprv_ prefix (#552 PR 5)', async () => {
    const { channel, calls } = setupChannel()
    await channel.send(makeNotification())
    const body = calls[0]!.body as { text: string }
    // PR 5 surfaces the approval id with a visible aprv_ prefix so
    // operators distinguish Foreman approval ids from agent session ids.
    expect(body.text).toContain('/approve aprv_notif-abc123')
    expect(body.text).toContain('/deny aprv_notif-abc123')
  })

  it('embeds /approve_remember and /deny_remember (with aprv_ prefix) for allow_always / deny_always actions', async () => {
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
    expect(body.text).toContain('/approve aprv_notif-abc123')
    expect(body.text).toContain('/approve_remember aprv_notif-abc123')
    expect(body.text).toContain('/deny aprv_notif-abc123')
    expect(body.text).toContain('/deny_remember aprv_notif-abc123')
  })

  // #522 — Foreman now attaches an inline keyboard. The no-polling rule
  // from #406 still holds: Foreman doesn't getUpdates. The agent's own
  // getUpdates consumer sees the callback_query and relays it via
  // submit_approval, the same MCP tool the typed slash command uses.
  it('renders a reply_markup inline_keyboard for the standard allow/deny actions (#522)', async () => {
    const { channel, calls } = setupChannel()
    await channel.send(makeNotification())
    const body = calls[0]!.body as { reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }
    expect(body.reply_markup).toBeDefined()
    const buttons = body.reply_markup!.inline_keyboard.flat()
    expect(buttons.map((b) => b.text)).toEqual(['Allow once', 'Deny'])
  })

  it('encodes callback_data as `fa:<id>:<notifId>` so the agent can parse it (#522)', async () => {
    const { channel, calls } = setupChannel()
    await channel.send(makeNotification())
    const body = calls[0]!.body as { reply_markup?: { inline_keyboard: Array<Array<{ callback_data: string }>> } }
    const data = body.reply_markup!.inline_keyboard.flat().map((b) => b.callback_data)
    expect(data).toEqual(['fa:allow:notif-abc123', 'fa:deny:notif-abc123'])
  })

  it('keeps the text-command fallback alive alongside the inline keyboard (#522)', async () => {
    // Older clients drop callback taps; forwarded messages strip reply_markup.
    // The typed-command path must keep working in both cases.
    const { channel, calls } = setupChannel()
    await channel.send(makeNotification())
    const body = calls[0]!.body as { text: string; reply_markup?: unknown }
    expect(body.reply_markup).toBeDefined()
    // PR 5: ids surface with the aprv_ display prefix.
    expect(body.text).toContain('/approve aprv_notif-abc123')
    expect(body.text).toContain('/deny aprv_notif-abc123')
  })

  it('renders body only (no slash-command block) when actions is empty (info-only alert)', async () => {
    const { channel, calls } = setupChannel()
    await channel.send(makeNotification({ actions: [] }))
    const body = calls[0]!.body as { text: string; reply_markup?: unknown }
    expect(body.text).not.toContain('/approve')
    expect(body.text).not.toContain('/deny')
    expect(body.text).toContain('Phishing pattern')
    // Also no reply_markup when there are no actions — info-only alerts
    // don't need a keyboard, and Telegram complains about empty rows.
    expect(body.reply_markup).toBeUndefined()
  })

  it('skips inspect actions in the command list (no slash command for inspect)', async () => {
    const { channel, calls } = setupChannel()
    await channel.send(
      makeNotification({
        actions: [
          { id: 'allow', label: 'Allow once' },
          { id: 'inspect', label: 'Inspect', intent: 'custom' },
          { id: 'deny', label: 'Deny' },
        ],
      }),
    )
    const body = calls[0]!.body as {
      text: string
      reply_markup?: { inline_keyboard: Array<Array<{ text: string }>> }
    }
    expect(body.text).toContain('/approve aprv_notif-abc123')
    expect(body.text).toContain('/deny aprv_notif-abc123')
    expect(body.text).not.toContain('/inspect')
    // Inspect is render-only (intent: 'custom' with no payload). It must
    // also be excluded from the inline keyboard so the user can't tap a
    // button that has no round-trip. See #522 isInteractiveAction.
    const labels = body.reply_markup!.inline_keyboard.flat().map((b) => b.text)
    expect(labels).toEqual(['Allow once', 'Deny'])
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

// =============================================================================
// #522 — Inline keyboard helper (renderInlineKeyboard).
//
// These tests target the pure helper independently so future channels
// (Discord components, Slack block_actions) can reuse the same shaping
// rules without re-implementing the layout / filter logic.
// =============================================================================
describe('renderInlineKeyboard (#522)', () => {
  it('returns undefined when there are no actions', () => {
    expect(renderInlineKeyboard([], 'n-1')).toBeUndefined()
  })

  it('returns undefined when every action is non-interactive', () => {
    // inspect = intent 'custom' with no payload → render-only.
    const actions: ChannelAction[] = [
      { id: 'inspect', label: 'Inspect', intent: 'custom' },
    ]
    expect(renderInlineKeyboard(actions, 'n-1')).toBeUndefined()
  })

  it('lays out 2 actions as a single row', () => {
    const out = renderInlineKeyboard(
      [
        { id: 'allow', label: 'Allow' },
        { id: 'deny', label: 'Deny' },
      ],
      'n-1',
    )!
    expect(out.inline_keyboard).toHaveLength(1)
    expect(out.inline_keyboard[0]).toHaveLength(2)
  })

  it('lays out 4 actions as two rows of two (2-up grid)', () => {
    const out = renderInlineKeyboard(
      [
        { id: 'allow', label: 'Allow' },
        { id: 'allow_always', label: 'Allow + remember' },
        { id: 'deny', label: 'Deny' },
        { id: 'deny_always', label: 'Deny + remember' },
      ],
      'n-1',
    )!
    expect(out.inline_keyboard).toHaveLength(2)
    expect(out.inline_keyboard[0]).toHaveLength(2)
    expect(out.inline_keyboard[1]).toHaveLength(2)
  })

  it('encodes callback_data as fa:<id>:<notifId> for every button', () => {
    const out = renderInlineKeyboard(
      [
        { id: 'allow', label: 'Allow' },
        { id: 'deny_always', label: 'Always deny' },
      ],
      'notif-xyz',
    )!
    const data = out.inline_keyboard.flat().map((b) => b.callback_data)
    expect(data).toEqual(['fa:allow:notif-xyz', 'fa:deny_always:notif-xyz'])
  })

  it('keeps callback_data well under Telegram\'s 64-byte cap even with ULID notif ids', () => {
    // 26-char ULID + 11-char id ('deny_always') + 'fa:' + 2 colons = 42 bytes.
    const out = renderInlineKeyboard(
      [{ id: 'deny_always', label: 'Always deny' }],
      '01HZXY4MNJK8N9P3Q7R5T6V2WB',
    )!
    const data = out.inline_keyboard.flat()[0]!.callback_data
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThan(64)
  })

  it('drops inspect (custom intent without payload) but keeps custom WITH payload', () => {
    // The custom-with-payload case is the downstream extension point
    // (#526 block-pattern, #527 resolution choice, #528 option choice).
    const out = renderInlineKeyboard(
      [
        { id: 'allow', label: 'Allow' },
        { id: 'inspect', label: 'Inspect', intent: 'custom' },
        {
          id: 'block_pattern',
          label: 'Block pattern',
          intent: 'custom',
          payload: { rule: 'deny Bash(rm:*)' },
        },
      ],
      'n-1',
    )!
    const labels = out.inline_keyboard.flat().map((b) => b.text)
    expect(labels).toEqual(['Allow', 'Block pattern'])
  })

  it('derives intent from id when omitted (backward compat)', () => {
    // Legacy callsites pass { id: 'allow', label: '…' } without intent.
    // The keyboard still includes them — intentForActionId fills the gap.
    const out = renderInlineKeyboard(
      [
        { id: 'allow', label: 'Allow' },
        { id: 'allow_always', label: 'Allow + remember' },
      ],
      'n-1',
    )!
    expect(out.inline_keyboard.flat()).toHaveLength(2)
  })
})

describe('intentForActionId (#522)', () => {
  it.each([
    ['allow', 'allow'],
    ['deny', 'deny'],
    ['allow_always', 'remember-allow'],
    ['deny_always', 'remember-deny'],
  ] as const)('maps legacy id %s → intent %s', (id, expected) => {
    expect(intentForActionId(id)).toBe(expected)
  })

  it('falls through to custom for any unknown id (forward-compat for #526/#527/#528)', () => {
    expect(intentForActionId('block_pattern')).toBe('custom')
    expect(intentForActionId('inspect')).toBe('custom')
    expect(intentForActionId('')).toBe('custom')
  })
})
