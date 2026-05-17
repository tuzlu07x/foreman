import type {
  ChannelMessageRef,
  Notification,
  NotificationAction,
  NotificationChannel,
  UserDecision,
} from '../types.js'

// =============================================================================
// Telegram Bot API channel (#235 / C11a)
// =============================================================================
//
// Uses long-polling (getUpdates) — no public webhook endpoint required so the
// channel works on a developer's laptop behind NAT. HTTP client is injected
// so tests can mock it. Callback verification: every tap must come from the
// configured chat_id (prevents shared-group bystanders from deciding).

export interface TelegramFetch {
  (url: string, init?: RequestInit): Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
    text(): Promise<string>
  }>
}

export interface TelegramChannelOptions {
  botToken: string
  chatId: string
  /** Injected so tests can supply a mocked transport. Defaults to global fetch. */
  fetchImpl?: TelegramFetch
  /** Long-poll timeout in seconds — Telegram caps at 50. */
  pollTimeout?: number
  /** Internal: stop the poll loop after N successful polls. Only used by tests. */
  maxPolls?: number
}

interface TelegramSendResponse {
  ok: boolean
  result?: { message_id: number; chat: { id: number } }
  description?: string
}

interface TelegramUpdate {
  update_id: number
  callback_query?: {
    id: string
    from: { id: number; username?: string }
    data: string
    message?: { message_id: number; chat: { id: number } }
  }
}

interface TelegramGetUpdatesResponse {
  ok: boolean
  result?: TelegramUpdate[]
  description?: string
}

const TELEGRAM_API = 'https://api.telegram.org'

export class TelegramChannel implements NotificationChannel {
  readonly id = 'telegram' as const

  private readonly botToken: string
  private readonly chatId: string
  private readonly fetchImpl: TelegramFetch
  private readonly pollTimeout: number
  private readonly maxPolls: number
  private decisionHandler: ((d: UserDecision) => Promise<void>) | null = null
  private pollLoop: Promise<void> | null = null
  private stopRequested = false
  private lastUpdateId = 0
  /** Maps Telegram `callback_data` payloads back to our notification id. */
  private readonly outstandingByMessageId = new Map<
    string,
    { notificationId: string }
  >()

  constructor(opts: TelegramChannelOptions) {
    this.botToken = opts.botToken
    this.chatId = opts.chatId
    this.fetchImpl =
      opts.fetchImpl ?? ((url, init) => fetch(url, init) as never)
    this.pollTimeout = opts.pollTimeout ?? 25
    this.maxPolls = opts.maxPolls ?? Number.POSITIVE_INFINITY
  }

  async isReady(): Promise<boolean> {
    const res = (await this.call('getMe', {})) as { ok?: boolean } | null
    return Boolean(res?.ok)
  }

  async send(n: Notification): Promise<ChannelMessageRef> {
    const reply_markup = this.buildKeyboard(n)
    const text = this.renderText(n)
    const res = (await this.call('sendMessage', {
      chat_id: this.chatId,
      text,
      parse_mode: 'MarkdownV2',
      reply_markup,
      disable_web_page_preview: true,
    })) as TelegramSendResponse

    if (!res?.ok || !res.result) {
      throw new TelegramApiError(res?.description ?? 'sendMessage failed')
    }
    const ref: ChannelMessageRef = {
      channelMessageId: String(res.result.message_id),
    }
    this.outstandingByMessageId.set(ref.channelMessageId, {
      notificationId: n.id,
    })
    return ref
  }

  async updateMessage(ref: ChannelMessageRef, body: string): Promise<void> {
    await this.call('editMessageText', {
      chat_id: this.chatId,
      message_id: Number(ref.channelMessageId),
      text: escapeMd(body),
      parse_mode: 'MarkdownV2',
    })
  }

  async listen(onDecision: (d: UserDecision) => Promise<void>): Promise<void> {
    this.decisionHandler = onDecision
    if (this.pollLoop) return
    this.stopRequested = false
    this.pollLoop = (async () => {
      let polls = 0
      while (!this.stopRequested && polls < this.maxPolls) {
        polls += 1
        try {
          await this.pollOnce()
        } catch {
          // Don't kill the poll loop on transient network errors. Real
          // implementations would log; tests inject a controllable fetch
          // and assert the flow that way.
        }
      }
    })()
  }

  async shutdown(): Promise<void> {
    this.stopRequested = true
    if (this.pollLoop) {
      try {
        await this.pollLoop
      } catch {
        // ignore
      }
      this.pollLoop = null
    }
    this.decisionHandler = null
  }

  // ============================================================================
  // Internals
  // ============================================================================

  private async pollOnce(): Promise<void> {
    const res = (await this.call('getUpdates', {
      offset: this.lastUpdateId + 1,
      timeout: this.pollTimeout,
      allowed_updates: ['callback_query'],
    })) as TelegramGetUpdatesResponse

    if (!res?.ok || !res.result) return
    for (const update of res.result) {
      this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id)
      const cb = update.callback_query
      if (!cb || !cb.message) continue

      // 1. Verify the tap is from the configured chat.
      const fromChat = String(cb.message.chat.id)
      if (fromChat !== this.chatId) continue

      // 2. Map message_id back to our notification.
      const ref = this.outstandingByMessageId.get(String(cb.message.message_id))
      if (!ref) continue

      // 3. Parse decision from callback_data — schema: "<notificationId>:<action>"
      const [encodedId, action] = cb.data.split(':')
      if (!encodedId || !action || encodedId !== ref.notificationId) continue
      if (!isKnownAction(action)) continue

      const decision: UserDecision = {
        notificationId: ref.notificationId,
        decision: action,
        decidedBy: String(cb.from.id),
        decidedAt: Date.now(),
      }
      this.outstandingByMessageId.delete(String(cb.message.message_id))
      if (this.decisionHandler) await this.decisionHandler(decision)

      // 4. Best-effort answer the callback so Telegram clears the loading
      //    spinner on the user's button + surfaces a richer confirmation
      //    toast (#302). Failure is non-fatal.
      try {
        await this.call('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: confirmationText(action),
        })
      } catch {
        // ignore
      }
    }
  }

  private buildKeyboard(n: Notification): {
    inline_keyboard: { text: string; callback_data: string }[][]
  } {
    const row = n.actions.map((a) => ({
      text: actionEmoji(a) + ' ' + a.label,
      callback_data: `${n.id}:${a.id}`,
    }))
    return { inline_keyboard: row.length ? [row] : [] }
  }

  private renderText(n: Notification): string {
    const head = `*${escapeMd(n.title)}*`
    return `${head}\n\n${escapeMd(n.body)}`
  }

  private async call(method: string, body: unknown): Promise<unknown> {
    const url = `${TELEGRAM_API}/bot${this.botToken}/${method}`
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '<no body>')
      throw new TelegramApiError(`${method} HTTP ${res.status}: ${text}`)
    }
    return res.json()
  }
}

export class TelegramApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TelegramApiError'
  }
}

const ACTION_IDS = new Set([
  'allow',
  'deny',
  'allow_always',
  'deny_always',
  'timeout_default',
])

function isKnownAction(s: string): s is UserDecision['decision'] {
  return ACTION_IDS.has(s)
}

function actionEmoji(a: NotificationAction): string {
  if (a.id === 'allow' || a.id === 'allow_always') return '✓'
  if (a.id === 'deny' || a.id === 'deny_always') return '✗'
  if (a.id === 'inspect') return '👁'
  return '•'
}

// Map action id → user-facing toast that pops on Telegram when the button
// is pressed (#302). Keeps the confirmation specific to what the user did
// — beats the prior bare `✓ allow`.
function confirmationText(action: string): string {
  switch (action) {
    case 'allow':
      return '✓ Approved — Foreman has resumed the agent.'
    case 'allow_always':
      return '✓ Approved + remembered — Foreman will auto-allow this in future.'
    case 'deny':
      return '✗ Denied — Foreman blocked the request.'
    case 'deny_always':
      return '✗ Denied + remembered — Foreman will auto-deny this in future.'
    case 'inspect':
      return '👁 Inspect — open Foreman TUI for details.'
    default:
      return `✓ ${action}`
  }
}

// Telegram MarkdownV2 reserves these chars and rejects messages with unescaped
// instances. Conservative escape — safer than allowing partial-Markdown
// formatting to slip through and break the message.
const MD_ESCAPE_RE = /([_*\[\]()~`>#+\-=|{}.!\\])/g

export function escapeMd(s: string): string {
  return s.replace(MD_ESCAPE_RE, '\\$1')
}
