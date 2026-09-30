import { formatApprovalIdForDisplay } from '../../approval-id.js'
import { compactBlockActionId } from '../../approval-token.js'
import {
  APPROVAL_BUTTON_ACTIONS,
  decisionFromButton,
  decisionLabel,
  pause,
  verifyApprovalButton,
} from './approval-buttons.js'
import {
  intentForActionId,
  StaleDecisionError,
  type ChannelAction,
  type ChannelMessageRef,
  type Notification,
  type NotificationAction,
  type NotificationChannel,
  type UserDecision,
} from '../types.js'

// =============================================================================
// Telegram Bot API channel
// =============================================================================
//
// Which bot Foreman reads is decided by the caller (channel-factory.ts,
// telegram-listener.ts) and passed in as `approvalBotToken`:
//   - no chat agent uses the bot: the main bot itself. One bot carries
//     notifications, approval buttons and `/foreman` (plain text too);
//   - a chat agent shares the main bot: a second bot only Foreman reads
//     (#610), or none — then Foreman only sends, as below.
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
  /** Approval-token signer (see approval-token.ts). When set, approval
   *  buttons carry `<approvalId>.<tag>` and the message text offers only
   *  the (harmless) typed deny: anything that grants access needs a tap. */
  signApproval?: (approvalId: string, actionId: string) => string
  /** Dedicated approval bot (#610): a second bot whose token only Foreman
   *  holds. Approval prompts are sent through it and Foreman polls it for
   *  the taps itself, so no agent ever sees an approval button. */
  approvalBotToken?: string
  /** Signer for the approval bot's buttons: a different key from
   *  signApproval, so a relay can never replay one (approval-token.ts). */
  signButton?: (approvalId: string, actionId: string) => string
  /** Trouble with the approval bot (another poller, a revoked token). */
  onWarning?: (message: string) => void
  /** Long-poll timeout in seconds (tests use 0). */
  pollTimeoutSeconds?: number
  /** Wait after a failed poll, in ms. */
  pollBackoffMs?: number
  /** Minimum time between polls, in case long polling isn't honoured
   *  (a proxy answering at once) — never a hot loop. */
  minPollIntervalMs?: number
  /** `/integrations`, `/integration …` and `/foreman …` sent to the
   *  approval bot from your own private chat. Returns the reply text. */
  onCommand?: (text: string, userId: string, opts?: ChatCommandOptions) => Promise<string>
}

/** How a chat command was typed: `plain` is text without a leading slash,
 *  taken as `/foreman <text>` but only for reading (see foreman-command.ts
 *  plainTextRefusal). */
export interface ChatCommandOptions {
  plain?: boolean
}

/** Commands the approval bot takes (Telegram lists them in the chat menu). */
const APPROVAL_BOT_COMMANDS = [
  { command: 'integrations', description: 'List integrations' },
  { command: 'integration', description: 'status | enable | disable | remove <name>' },
  { command: 'foreman', description: 'Foreman commands (help, status, report, …)' },
]
const APPROVAL_BOT_COMMAND_RE = /^\/(integrations|integration|foreman)(@[A-Za-z0-9_]{1,64})?(?=\s|$)/i
const TELEGRAM_TEXT_MAX = 3900

/** Button actions the approval bot resolves itself. */
const APPROVAL_BOT_ACTIONS: ReadonlySet<string> = new Set(APPROVAL_BUTTON_ACTIONS)
/** Message refs sent through the approval bot carry this prefix, so edits
 *  go through the same bot. */
const APPROVAL_REF_PREFIX = 'a:'

interface TelegramUpdate {
  update_id: number
  callback_query?: {
    id: string
    from?: { id?: number | string }
    data?: string
    message?: { message_id: number; chat?: { id?: number | string } }
  }
  message?: {
    text?: string
    /** Unix seconds, when it was sent. */
    date?: number
    chat?: { id?: number | string; type?: string }
    from?: { id?: number | string; is_bot?: boolean }
  }
}

/** A chat message sent this long before Foreman started reading the bot is
 *  not run: Telegram keeps undelivered updates for a day, and a `stop` or
 *  `write` typed while Foreman was off must not act hours later. */
export const STALE_MESSAGE_MS = 2 * 60 * 1000

interface TelegramSendResponse {
  ok: boolean
  result?: { message_id: number; chat: { id: number } }
  description?: string
}

const TELEGRAM_API = 'https://api.telegram.org'
const MAX_OPEN_KEYBOARDS = 500

export class TelegramChannel implements NotificationChannel {
  readonly id = 'telegram' as const

  private readonly botToken: string
  private readonly chatId: string
  private readonly fetchImpl: TelegramFetch
  private readonly signApproval?: (approvalId: string, actionId: string) => string
  private readonly approvalBotToken?: string
  private readonly signButton?: (approvalId: string, actionId: string) => string
  private readonly onWarning: (message: string) => void
  private readonly onCommand?: (text: string, userId: string, opts?: ChatCommandOptions) => Promise<string>
  private readonly pollTimeoutSeconds: number
  private readonly pollBackoffMs: number
  private readonly minPollIntervalMs: number
  private polling: { stop: boolean; abort: AbortController; done: Promise<void> } | null = null
  /** When the current poller started: older chat messages are stale. */
  private pollStartedAt = 0
  /** Stale messages skipped since the poller started, told once. */
  private staleSkipped = 0
  /** Keyboards of messages still open, so a countdown edit keeps them
   *  (editMessageText without reply_markup removes the buttons). */
  private readonly keyboards = new Map<string, unknown>()

  constructor(opts: TelegramChannelOptions) {
    this.botToken = opts.botToken
    this.chatId = opts.chatId
    this.signApproval = opts.signApproval
    this.approvalBotToken = opts.approvalBotToken
    this.signButton = opts.signButton
    this.onWarning = opts.onWarning ?? (() => {})
    if (opts.onCommand) this.onCommand = opts.onCommand
    this.pollTimeoutSeconds = opts.pollTimeoutSeconds ?? 25
    this.pollBackoffMs = opts.pollBackoffMs ?? 5_000
    this.minPollIntervalMs = opts.minPollIntervalMs ?? 1_000
    this.fetchImpl =
      opts.fetchImpl ?? ((url, init) => fetch(url, init) as never)
  }

  /** Whether Foreman reads a bot's updates here (taps and `/foreman`):
   *  its own bot, or the main one when no chat agent shares it. */
  get readsUpdates(): boolean {
    return this.approvalBotToken !== undefined
  }

  /** The bot Foreman reads, as its warnings name it: the approval bot, or
   *  in one-bot mode (listener: foreman) your only Telegram bot. */
  private get foremanBotName(): string {
    return this.approvalBotToken === this.botToken ? 'your Telegram bot' : 'the Telegram approval bot'
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
    // Approvals go through the dedicated bot when there is one: taps come
    // back to Foreman only, never to the chat agent sharing the main bot.
    const viaApprovalBot =
      this.approvalBotToken !== undefined && n.actions.some((a) => APPROVAL_BOT_ACTIONS.has(a.id))
    const text = viaApprovalBot ? this.renderApprovalBotText(n) : this.renderText(n)
    const body: Record<string, unknown> = {
      chat_id: this.chatId,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    }
    const actions = viaApprovalBot ? n.actions.filter((a) => APPROVAL_BOT_ACTIONS.has(a.id)) : n.actions
    const reply_markup = renderInlineKeyboard(actions, n.id, this.targets(n, viaApprovalBot))
    if (reply_markup) body.reply_markup = reply_markup
    const res = (await this.call(
      'sendMessage',
      body,
      viaApprovalBot ? this.approvalBotToken : this.botToken,
    )) as TelegramSendResponse

    if (!res?.ok || !res.result) {
      throw new TelegramApiError(res?.description ?? 'sendMessage failed')
    }
    const id = String(res.result.message_id)
    const channelMessageId = viaApprovalBot ? `${APPROVAL_REF_PREFIX}${id}` : id
    if (reply_markup) {
      this.keyboards.set(channelMessageId, reply_markup)
      if (this.keyboards.size > MAX_OPEN_KEYBOARDS) {
        const oldest = this.keyboards.keys().next().value
        if (oldest !== undefined) this.keyboards.delete(oldest)
      }
    }
    return { channelMessageId }
  }

  async updateMessage(ref: ChannelMessageRef, body: string, opts: { final?: boolean } = {}): Promise<void> {
    const viaApprovalBot = ref.channelMessageId.startsWith(APPROVAL_REF_PREFIX)
    const messageId = viaApprovalBot
      ? ref.channelMessageId.slice(APPROVAL_REF_PREFIX.length)
      : ref.channelMessageId
    // A countdown refresh keeps the buttons; the outcome removes them.
    const keyboard = opts.final ? { inline_keyboard: [] } : this.keyboards.get(ref.channelMessageId)
    if (opts.final) this.keyboards.delete(ref.channelMessageId)
    await this.call(
      'editMessageText',
      {
        chat_id: this.chatId,
        message_id: Number(messageId),
        text: escapeMd(body),
        parse_mode: 'MarkdownV2',
        ...(keyboard ? { reply_markup: keyboard } : {}),
      },
      viaApprovalBot ? this.approvalBotToken : this.botToken,
    )
  }

  // #406 — Listen + shutdown are kept so NotificationChannel stays
  // single-shape across transports. Foreman doesn't poll Telegram
  // anymore; decision routing happens via the `submit_approval` MCP
  // tool. The `onDecision` handler is intentionally retained for type
  // compatibility but never invoked from here.
  //
  // #610 — The exception is the dedicated approval bot: its token is
  // Foreman's alone, so Foreman is its only `getUpdates` consumer and there
  // is no conflict with the chat agent.
  async listen(onDecision: (d: UserDecision) => Promise<void>): Promise<void> {
    if (!this.approvalBotToken || this.polling) return
    const state = { stop: false, abort: new AbortController(), done: Promise.resolve() }
    state.done = this.pollApprovalBot(state, onDecision)
    this.polling = state
    if (this.onCommand) {
      // Best-effort: the chat menu lists the commands.
      void this.call('setMyCommands', { commands: APPROVAL_BOT_COMMANDS }, this.approvalBotToken).catch(() => undefined)
    }
  }

  async shutdown(): Promise<void> {
    const state = this.polling
    if (!state) return
    this.polling = null
    state.stop = true
    state.abort.abort()
    await state.done.catch(() => undefined)
  }

  // ============================================================================
  // Internals
  // ============================================================================

  /** How each button / command identifies what it acts on. Approval
   *  actions reference the pending approval (`n.requestId`, signed when a
   *  signer is configured) — the notification's own ULID is unknown to
   *  `submit_approval`, which is why relayed approvals used to fail with
   *  "not found". */
  private targets(n: Notification, viaApprovalBot = false): KeyboardTargets {
    const sign = viaApprovalBot ? this.signButton : this.signApproval
    return {
      approvalId: n.requestId,
      ...(sign ? { sign } : {}),
      chatId: this.chatId,
    }
  }

  private renderText(n: Notification): string {
    const head = `*${escapeMd(n.title)}*`
    const summary = escapeMd(n.body)
    const targets = this.targets(n)
    const commands = renderActionCommands(n, targets)
    const tapHint =
      targets.sign && n.actions.some((a) => a.id === 'allow')
        ? `\n${escapeMd('To allow, tap a button (or use the Foreman TUI).')}`
        : ''
    if (commands.length === 0) {
      return `${head}\n\n${summary}${tapHint}`
    }
    const sep = escapeMd('Reply in this chat:')
    return `${head}\n\n${summary}\n\n${sep}\n${commands}${tapHint}`
  }

  /** Approval-bot messages: no typed commands, just the buttons. */
  private renderApprovalBotText(n: Notification): string {
    return `*${escapeMd(n.title)}*\n\n${escapeMd(n.body)}`
  }

  // ---------------------------------------------------------------------------
  // Approval bot polling (#610)
  // ---------------------------------------------------------------------------

  private async pollApprovalBot(
    state: { stop: boolean; abort: AbortController },
    onDecision: (d: UserDecision) => Promise<void>,
  ): Promise<void> {
    let offset = 0
    let warnedUnreachable = false
    this.pollStartedAt = Date.now()
    this.staleSkipped = 0
    while (!state.stop) {
      const startedAt = Date.now()
      let res: Awaited<ReturnType<TelegramFetch>>
      try {
        res = await this.fetchImpl(`${TELEGRAM_API}/bot${this.approvalBotToken}/getUpdates`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            offset,
            timeout: this.pollTimeoutSeconds,
            allowed_updates: ['callback_query', 'message'],
          }),
          signal: state.abort.signal,
        })
      } catch (err) {
        if (state.stop) return
        if (!warnedUnreachable) {
          warnedUnreachable = true
          this.onWarning(
            `Can't reach ${this.foremanBotName} (${err instanceof Error ? err.message : String(err)}); retrying.`,
          )
        }
        await pause(this.pollBackoffMs, state.abort.signal)
        continue
      }
      warnedUnreachable = false
      if (res.status === 409) {
        this.onWarning(
          this.approvalBotToken === this.botToken
            ? 'Another program is reading your Telegram bot (a chat agent?), so Foreman gets no taps. Set listener: agent under channels.telegram in notify.yaml and add an approval bot (foreman notify approval-bot) — see docs/notifications.md.'
            : 'Another process is polling the Telegram approval bot. It must be a bot only Foreman uses — see docs/notifications.md.',
        )
        await pause(Math.max(this.pollBackoffMs, 30_000), state.abort.signal)
        continue
      }
      if (res.status === 401 || res.status === 404) {
        this.onWarning(
          this.approvalBotToken === this.botToken
            ? 'Telegram rejected your Telegram bot token; approvals fall back to the TUI.'
            : 'Telegram rejected the approval bot token; approvals fall back to the TUI.',
        )
        return
      }
      if (!res.ok) {
        await pause(this.pollBackoffMs, state.abort.signal)
        continue
      }
      const body = (await res.json().catch(() => null)) as { result?: TelegramUpdate[] } | null
      const updates = body?.result ?? []
      const skippedBefore = this.staleSkipped
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1)
        try {
          await this.handleApprovalBotUpdate(update, onDecision)
        } catch {
          // One bad update must not stop the poller.
        }
      }
      if (this.staleSkipped > skippedBefore) await this.tellStaleSkipped(this.staleSkipped - skippedBefore)
      const elapsed = Date.now() - startedAt
      if (updates.length === 0 && elapsed < this.minPollIntervalMs) {
        await pause(this.minPollIntervalMs - elapsed, state.abort.signal)
      }
    }
  }

  /** A command from your own private chat only: the sender, the chat and
   *  the configured chat_id are the same id, the chat is private and the
   *  sender isn't a bot. Anything else is ignored without a reply. */
  private async handleApprovalBotCommand(
    msg: NonNullable<TelegramUpdate['message']>,
    typed: string = msg.text!.trim(),
    opts: ChatCommandOptions = {},
  ): Promise<void> {
    const fromId = String(msg.from?.id ?? '')
    const chatId = String(msg.chat?.id ?? '')
    if (msg.chat?.type !== 'private' || msg.from?.is_bot === true) return
    if (fromId !== this.chatId || chatId !== this.chatId) return
    const text = typed.replace(APPROVAL_BOT_COMMAND_RE, (_m, verb: string) => `/${verb.toLowerCase()}`)
    let reply: string
    try {
      reply = await this.onCommand!(text, fromId, opts)
    } catch (err) {
      reply = `That didn't work: ${err instanceof Error ? err.message : String(err)}`
    }
    await this.call(
      'sendMessage',
      { chat_id: this.chatId, text: reply.length > TELEGRAM_TEXT_MAX ? `${reply.slice(0, TELEGRAM_TEXT_MAX - 1)}…` : reply },
      this.approvalBotToken,
    )
  }

  /** One note for the messages skipped as stale, in your own chat. */
  private async tellStaleSkipped(n: number): Promise<void> {
    await this.call(
      'sendMessage',
      {
        chat_id: this.chatId,
        text:
          `Foreman was off when you sent ${n === 1 ? 'your last message' : `your last ${n} messages`}, ` +
          'so I did not act on them. Send again what you still want.',
      },
      this.approvalBotToken,
    )
  }

  private async handleApprovalBotUpdate(
    update: TelegramUpdate,
    onDecision: (d: UserDecision) => Promise<void>,
  ): Promise<void> {
    const tap = update.callback_query
    if (!tap) {
      const msg = update.message
      // Sent while Foreman wasn't reading the bot: don't run it now.
      if (msg && typeof msg.date === 'number' && msg.date * 1000 < this.pollStartedAt - STALE_MESSAGE_MS) {
        if (String(msg.chat?.id) === this.chatId && msg.text) this.staleSkipped++
        return
      }
      if (msg && this.onCommand && msg.text && APPROVAL_BOT_COMMAND_RE.test(msg.text.trim())) {
        await this.handleApprovalBotCommand(msg)
        return
      }
      if (msg && String(msg.chat?.id) === this.chatId && msg.text?.startsWith('/start')) {
        await this.call(
          'sendMessage',
          {
            chat_id: this.chatId,
            text: this.onCommand
              ? 'Foreman is connected. Approval requests appear here with buttons. Ask me anything, e.g. "report me" or "what is claude-code doing?", or send /foreman help.'
              : this.approvalBotToken === this.botToken
                ? 'Foreman is connected. Approval requests will appear here; tap a button to decide.'
                : 'Foreman approval bot connected. Approval requests will appear here; tap a button to decide.',
          },
          this.approvalBotToken,
        )
        return
      }
      // Plain text in your own chat is a question for Foreman, as if it
      // began with /foreman. Other slash commands aren't Foreman's.
      const plain = msg?.text?.trim()
      if (msg && this.onCommand && plain && !plain.startsWith('/')) {
        await this.handleApprovalBotCommand(msg, `/foreman ${plain}`, { plain: true })
      }
      return
    }
    const answer = (text: string): Promise<unknown> =>
      this.call('answerCallbackQuery', { callback_query_id: tap.id, text }, this.approvalBotToken)
    // Only the configured user, in the configured private chat.
    const fromId = String(tap.from?.id ?? '')
    const chatId = String(tap.message?.chat?.id ?? '')
    if (chatId !== this.chatId || fromId !== this.chatId) {
      await answer('Not allowed.')
      return
    }
    const check = verifyApprovalButton(tap.data ?? '', this.signButton)
    if (!check.ok) {
      await answer(check.reason === 'invalid' ? 'This button is no longer valid.' : 'Unsupported button.')
      return
    }
    let reply = decisionLabel(check.decision)
    try {
      await onDecision(decisionFromButton(check, { channel: 'telegram', userId: fromId }))
    } catch (err) {
      if (!(err instanceof StaleDecisionError)) {
        // Keep the buttons so the user can try again.
        await answer("Couldn't record that decision. Try again.")
        return
      }
      reply = 'No longer open here.'
    }
    await answer(reply)
    // Take the buttons away so a second tap can't race the first.
    if (tap.message) {
      await this.call(
        'editMessageReplyMarkup',
        { chat_id: this.chatId, message_id: tap.message.message_id, reply_markup: { inline_keyboard: [] } },
        this.approvalBotToken,
      ).catch(() => undefined)
    }
  }

  private async call(method: string, body: unknown, token: string = this.botToken): Promise<unknown> {
    const url = `${TELEGRAM_API}/bot${token}/${method}`
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

function actionToCommand(
  a: NotificationAction,
  notifId: string,
  targets: KeyboardTargets = {},
): string | null {
  // #552 PR 5 — Surface the approval id with a visible `aprv_` prefix so
  // operators don't confuse it with codex / claude-code session/thread
  // ids (those are UUIDs; ours are ULIDs, but at a glance they can both
  // look like "long random string"). submit_approval strips the prefix
  // back off so the underlying DB id stays unchanged.
  if (targets.sign && targets.approvalId) {
    // Message text can be read back by any holder of the bot token without
    // the user doing anything, so no token that grants access goes there.
    // A plain deny needs none.
    return a.id === 'deny' ? `/deny ${formatApprovalIdForDisplay(targets.approvalId)}` : null
  }
  const displayId = formatApprovalIdForDisplay(approvalTargetFor(a.id, notifId, targets))
  switch (a.id) {
    case 'allow':
      return `/approve ${displayId}`
    case 'deny':
      return `/deny ${displayId}`
    case 'allow_always':
      return `/approve_remember ${displayId}`
    case 'deny_always':
      return `/deny_remember ${displayId}`
    case 'inspect':
      // Inspect doesn't resolve the approval — surfaced as a hint only.
      return null
    default:
      return null
  }
}

function renderActionCommands(n: Notification, targets: KeyboardTargets = {}): string {
  const lines: string[] = []
  for (const a of n.actions) {
    const cmd = actionToCommand(a, n.id, targets)
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
export interface KeyboardTargets {
  /** The pending approval this notification is about (Notification.requestId). */
  approvalId?: string | null
  /** Approval-token signer; see TelegramChannelOptions.signApproval. */
  sign?: (approvalId: string, actionId: string) => string
  /** Chat id — the documented tail of `ask_…` callbacks. */
  chatId?: string
}

/** Telegram rejects the WHOLE message when any callback_data exceeds 64
 *  bytes, so an over-long button is dropped instead (the text commands
 *  and the TUI still work). */
const MAX_CALLBACK_BYTES = 64

const APPROVAL_ACTION_IDS = new Set(['allow', 'deny', 'allow_always', 'deny_always'])

function isApprovalAction(actionId: string): boolean {
  return APPROVAL_ACTION_IDS.has(actionId) || actionId.startsWith('block_')
}

/** The id an approval action's button / command carries: the signed
 *  approval token when possible, the notification id otherwise. */
function approvalTargetFor(actionId: string, notifId: string, t: KeyboardTargets): string {
  if (!t.approvalId || !isApprovalAction(actionId)) return notifId
  if (!t.sign) return t.approvalId
  return `${t.approvalId}.${t.sign(t.approvalId, actionId)}`
}

function callbackTailFor(a: ChannelAction, notifId: string, t: KeyboardTargets): string {
  if (isApprovalAction(a.id)) return approvalTargetFor(a.id, notifId, t)
  const sessionId = a.payload?.sessionId
  if (a.id.startsWith('resolve_') && typeof sessionId === 'string') return sessionId
  if (a.id.startsWith('ask_') && t.chatId) return t.chatId
  return notifId
}

export function renderInlineKeyboard(
  actions: ChannelAction[],
  notifId: string,
  targets: KeyboardTargets = {},
): InlineKeyboardMarkup | undefined {
  const buttons: InlineKeyboardButton[] = []
  for (const a of actions) {
    if (!isInteractiveAction(a)) continue
    let data = `${CALLBACK_DATA_PREFIX}:${a.id}:${callbackTailFor(a, notifId, targets)}`
    if (Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_BYTES && a.id.startsWith('block_')) {
      // Long rule names: send the compact id (signed as such) instead.
      const compact = { ...a, id: compactBlockActionId(a.id) }
      data = `${CALLBACK_DATA_PREFIX}:${compact.id}:${callbackTailFor(compact, notifId, targets)}`
    }
    if (Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_BYTES) continue
    buttons.push({ text: a.label, callback_data: data })
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


