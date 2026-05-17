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

export interface NotificationAction {
  /** Stable id for callback verification — e.g. "allow", "deny", "allow_always". */
  id: 'allow' | 'deny' | 'allow_always' | 'deny_always' | 'inspect'
  /** Human-readable label rendered on the button. */
  label: string
  /** Visual hint — channels render this as a colour where supported. */
  style?: 'primary' | 'success' | 'danger' | 'neutral'
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
  actions: NotificationAction[]
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
