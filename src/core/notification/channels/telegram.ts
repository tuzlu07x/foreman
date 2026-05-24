import {
  intentForActionId,
  type ChannelAction,
  type ChannelMessageRef,
  type Notification,
  type NotificationAction,
  type NotificationChannel,
  type UserDecision,
} from '../types.js'

// =============================================================================
// Telegram Bot API channel — outbound-only after #406 (Yol C alignment)
// =============================================================================
//
// Before #406 this channel did both `sendMessage` (push approval prompts)
// AND `getUpdates` polling (receive Allow/Deny callback_query taps). When
// an agent like Hermes is configured for the same bot, both processes call
// `getUpdates` simultaneously and Telegram's API rejects the second with
// `Conflict: terminated by other getUpdates request`. The user's chat
// never reaches Hermes, Foreman's approval clicks never reach Foreman.
//
// After #406: Foreman is outbound-only. The agent (which is already the
// sole `getUpdates` consumer on the bot) receives the user's `/approve <id>`
// reply and relays the decision via the `submit_approval` MCP tool. No
// polling here. `listen()` and `shutdown()` are kept as interface no-ops
// so NotificationService doesn't branch per-channel.
//
// #522 — Foreman now also attaches a native `reply_markup` (inline keyboard)
// to approval messages. The agent's `getUpdates` consumer sees `callback_query`
// updates alongside `message` updates and routes both forms (button tap +
// typed slash command) into `submit_approval` per the SOUL.md instructions.
// Foreman itself still doesn't poll — the no-polling invariant from #406
// is preserved.

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
}

interface TelegramSendResponse {
  ok: boolean
  result?: { message_id: number; chat: { id: number } }
  description?: string
}

const TELEGRAM_API = 'https://api.telegram.org'

export class TelegramChannel implements NotificationChannel {
  readonly id = 'telegram' as const

  private readonly botToken: string
  private readonly chatId: string
  private readonly fetchImpl: TelegramFetch

  constructor(opts: TelegramChannelOptions) {
    this.botToken = opts.botToken
    this.chatId = opts.chatId
    this.fetchImpl =
      opts.fetchImpl ?? ((url, init) => fetch(url, init) as never)
  }

  async isReady(): Promise<boolean> {
    const res = (await this.call('getMe', {})) as { ok?: boolean } | null
    return Boolean(res?.ok)
  }

  async send(n: Notification): Promise<ChannelMessageRef> {
    // #406 + #522 — Body still embeds the slash-command fallback so users on
    // older clients (or those who prefer typing) keep working. On top of that,
    // attach an inline keyboard so a tap also resolves the approval. The
    // agent's existing `getUpdates` consumer sees both `message` and
    // `callback_query` updates and routes each into `submit_approval`.
    const text = this.renderText(n)
    const body: Record<string, unknown> = {
      chat_id: this.chatId,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    }
    const reply_markup = renderInlineKeyboard(n.actions, n.id)
    if (reply_markup) body.reply_markup = reply_markup
    const res = (await this.call('sendMessage', body)) as TelegramSendResponse

    if (!res?.ok || !res.result) {
      throw new TelegramApiError(res?.description ?? 'sendMessage failed')
    }
    return { channelMessageId: String(res.result.message_id) }
  }

  async updateMessage(ref: ChannelMessageRef, body: string): Promise<void> {
    await this.call('editMessageText', {
      chat_id: this.chatId,
      message_id: Number(ref.channelMessageId),
      text: escapeMd(body),
      parse_mode: 'MarkdownV2',
    })
  }

  // #406 — Listen + shutdown are kept so NotificationChannel stays
  // single-shape across transports. Foreman doesn't poll Telegram
  // anymore; decision routing happens via the `submit_approval` MCP
  // tool. The `onDecision` handler is intentionally retained for type
  // compatibility but never invoked from here.
  async listen(_onDecision: (d: UserDecision) => Promise<void>): Promise<void> {
    // intentional no-op (#406)
  }

  async shutdown(): Promise<void> {
    // intentional no-op (#406)
  }

  // ============================================================================
  // Internals
  // ============================================================================

  private renderText(n: Notification): string {
    const head = `*${escapeMd(n.title)}*`
    const summary = escapeMd(n.body)
    const commands = renderActionCommands(n)
    if (commands.length === 0) {
      return `${head}\n\n${summary}`
    }
    const sep = escapeMd('Reply in this chat:')
    return `${head}\n\n${summary}\n\n${sep}\n${commands}`
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

// =============================================================================
// Slash-command renderers (#406)
// =============================================================================
//
// Maps the channel-agnostic `NotificationAction` set to the slash commands
// the agent will recognize via SOUL.md instructions. Foreman side: render
// the command names + the notification id once. Agent side: when the user
// types one of these, the agent calls `submit_approval(approval_id,
// decision, remember?)`.

function actionToCommand(a: NotificationAction, notifId: string): string | null {
  switch (a.id) {
    case 'allow':
      return `/approve ${notifId}`
    case 'deny':
      return `/deny ${notifId}`
    case 'allow_always':
      return `/approve_remember ${notifId}`
    case 'deny_always':
      return `/deny_remember ${notifId}`
    case 'inspect':
      // Inspect doesn't resolve the approval — surfaced as a hint only.
      return null
    default:
      return null
  }
}

function renderActionCommands(n: Notification): string {
  const lines: string[] = []
  for (const a of n.actions) {
    const cmd = actionToCommand(a, n.id)
    if (!cmd) continue
    // Code-format the command + plain-text label.
    // MarkdownV2 inside backticks doesn't need extra escaping for the
    // command tokens themselves; the trailing label still needs escaping.
    lines.push(`\`${cmd}\`  ${escapeMd('→')} ${escapeMd(a.label)}`)
  }
  return lines.join('\n')
}

// =============================================================================
// Inline keyboard (#522)
// =============================================================================
//
// Telegram caps `callback_data` at 64 bytes. We use the format
// `fa:<id>:<notifId>` (fa = "foreman approval"). With the longest id we ship
// today (`deny_always`, 11 chars) plus a ULID notification id (26 chars) we
// land at 41 bytes — comfortably under the cap and leaves headroom for the
// downstream features that introduce custom action ids (#526, #527, #528).
//
// Why we keep the text-command fallback alive even when buttons render:
//   1. Older Telegram clients on weak connections silently drop callback
//      taps; the typed command still works.
//   2. Forwarded notification messages strip `reply_markup` — the typed
//      command is the only path on a forwarded copy.
//   3. The agent's existing `submit_approval` handler is the same on both
//      paths, so there's no extra surface area to maintain.

const CALLBACK_DATA_PREFIX = 'fa'

interface InlineKeyboardButton {
  text: string
  callback_data: string
}

interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][]
}

/** Build a Telegram inline_keyboard payload from a ChannelAction set.
 *  Returns `undefined` when there are no actionable buttons so callers
 *  can omit `reply_markup` entirely. Exported for tests. */
export function renderInlineKeyboard(
  actions: ChannelAction[],
  notifId: string,
): InlineKeyboardMarkup | undefined {
  const buttons: InlineKeyboardButton[] = []
  for (const a of actions) {
    if (!isInteractiveAction(a)) continue
    buttons.push({
      text: a.label,
      callback_data: `${CALLBACK_DATA_PREFIX}:${a.id}:${notifId}`,
    })
  }
  if (buttons.length === 0) return undefined
  // 2-up rows keep buttons big enough to tap reliably on mobile while still
  // letting a full 4-action ladder (allow / deny / allow_always / deny_always)
  // fit in two clean rows.
  const rows: InlineKeyboardButton[][] = []
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2))
  }
  return { inline_keyboard: rows }
}

/** A ChannelAction is "interactive" when a tap can be routed back to a
 *  decision. The legacy `inspect` action (intent: 'custom' with no
 *  payload) is render-only — we drop it from the keyboard. Custom intents
 *  WITH a payload (#526 block-pattern, #527 resolution choice, #528
 *  option choice) ARE interactive — the agent's bridge looks up the
 *  payload by action id and dispatches. */
function isInteractiveAction(a: ChannelAction): boolean {
  const intent = a.intent ?? intentForActionId(a.id)
  if (intent === 'custom') return Boolean(a.payload)
  return true
}

// Telegram MarkdownV2 reserves these chars and rejects messages with unescaped
// instances. Conservative escape — safer than allowing partial-Markdown
// formatting to slip through and break the message.
const MD_ESCAPE_RE = /([_*\[\]()~`>#+\-=|{}.!\\])/g

export function escapeMd(s: string): string {
  return s.replace(MD_ESCAPE_RE, '\\$1')
}
