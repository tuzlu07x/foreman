// Out-of-band notification types (#235 / C11a).
//
// `NotificationChannel` is the interface every transport implements
// (Telegram first; Discord / Slack / Webhook / System in C11b). The
// `NotificationService` owns config + dispatch + audit persistence.

export type NotificationLevel =
  | 'critical'
  | 'warning'
  | 'info'
  | 'summary'
  | 'budget_alert'
  /** #383 — auto-deny alert. Fired after the risk engine blocks a call
   *  without asking the user first (high-risk pattern caught). Routed
   *  via notify.yaml's `routing.risk_deny.channels`. */
  | 'risk_deny'

export type ChannelId = 'telegram' | 'discord' | 'slack' | 'webhook' | 'system'

/** Runtime-checkable list of every valid channel id. Exported so the notify
 *  CLI can reject typos before they end up in the user's notify.yaml (#264). */
export const KNOWN_CHANNELS: readonly ChannelId[] = [
  'telegram',
  'discord',
  'slack',
  'webhook',
  'system',
] as const

export function isKnownChannel(id: string): id is ChannelId {
  return (KNOWN_CHANNELS as readonly string[]).includes(id)
}

/** Semantic intent of an action — what a click MEANS to the approval /
 *  session bus, decoupled from the stable `id` channels round-trip in
 *  their native callback payload. Downstream features add custom
 *  buttons that resolve outside the allow/deny ladder (#526 policy
 *  injection, #527 session resume, #528 ask_user_with_options) using
 *  `intent: 'custom'` + a free-form `payload`. */
export type ActionIntent =
  | 'allow'
  | 'deny'
  | 'remember-allow'
  | 'remember-deny'
  | 'custom'

/** Channel-agnostic interactive button (#522). Channels that support a
 *  native primitive (Telegram inline_keyboard, Discord components, Slack
 *  block_actions) round-trip the `id` via their callback payload back to
 *  Foreman. Channels that don't support buttons fall back to text-command
 *  rendering — no breakage. */
export interface ChannelAction {
  /** Stable id sent back when the user clicks. Used to look up the
   *  approval + dispatch the decision. Must be unique within a single
   *  notification's action set. */
  id: string
  /** Human-readable label rendered on the button. */
  label: string
  /** What the click means semantically. Optional for backward compat:
   *  when omitted, derived from `id` via `intentForActionId` (allow /
   *  deny / allow_always / deny_always map to their natural intents,
   *  anything else falls through to `custom`). */
  intent?: ActionIntent
  /** Optional payload for `intent: 'custom'` — e.g. a policy predicate
   *  for #526's "Block pattern" button, an option id for #528's
   *  ask_user_with_options. Channels just round-trip it via their
   *  native callback mechanism; the approval bridge unpacks it. */
  payload?: Record<string, unknown>
  /** Visual hint — channels render this as a colour where supported. */
  style?: 'primary' | 'success' | 'danger' | 'neutral'
}

/** @deprecated Alias kept during the rename — prefer `ChannelAction`.
 *  Re-exported as the historical name so existing imports keep working. */
export type NotificationAction = ChannelAction

/** Map a legacy action id to its semantic intent. The approval bridge
 *  uses this when a channel callback only carries `id` (e.g. the older
 *  4-id ladder predates the #522 ChannelAction shape). */
export function intentForActionId(id: string): ActionIntent {
  switch (id) {
    case 'allow':
      return 'allow'
    case 'deny':
      return 'deny'
    case 'allow_always':
      return 'remember-allow'
    case 'deny_always':
      return 'remember-deny'
    default:
      return 'custom'
  }
}

export interface Notification {
  /** Stable id — also written to the `notifications` audit row. */
  id: string
  level: NotificationLevel
  /** Links to `requests.id` when this alert is for a tool call; null for
   *  scheduled summaries / budget alerts. */
  requestId: string | null
  /** Pre-rendered short title shown as the message subject (channel-specific). */
  title: string
  /** Body text — channels may transform / truncate per their limits. */
  body: string
  actions: ChannelAction[]
  /** When true, the caller (mediator) will await the channel's decision
   *  callback. C11a-2 wires this in. */
  agentBlocking: boolean
}

export interface ChannelMessageRef {
  /** Channel-specific message id (e.g. Telegram's `message_id`). */
  channelMessageId: string
}

export interface UserDecision {
  notificationId: string
  decision: 'allow' | 'deny' | 'allow_always' | 'deny_always' | 'timeout_default'
  /** Identifier of who tapped (channel-specific — e.g. Telegram user id). */
  decidedBy: string
  decidedAt: number
}

export interface NotificationChannel {
  id: ChannelId
  /** Is this channel ready to send (config + tokens valid)? */
  isReady(): Promise<boolean>
  /** Deliver the notification. Returns the channel-side message ref so the
   *  caller can later edit ("✓ Resolved by you") or cancel. */
  send(n: Notification): Promise<ChannelMessageRef>
  /** Best-effort message edit when a decision lands via another path
   *  (TUI / different channel). */
  updateMessage(ref: ChannelMessageRef, body: string): Promise<void>
  /** Begin listening for decision callbacks. The handler is called once per
   *  validated callback. */
  listen(onDecision: (d: UserDecision) => Promise<void>): Promise<void>
  /** Stop polling / close resources. */
  shutdown(): Promise<void>
}
