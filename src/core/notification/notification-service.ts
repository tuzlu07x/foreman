import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ForemanDb } from '../../db/client.js'
import { notificationMessages, notifications } from '../../db/schema.js'
import type { SecretStore } from '../secret-store.js'
import { isChannelEnabled, type NotifyConfig, routeFor } from './notify-config.js'
import type {
  ChannelId,
  ChannelMessageRef,
  Notification,
  NotificationChannel,
  NotificationLevel,
  UserDecision,
} from './types.js'

// =============================================================================
// Orchestration layer between policy → channels → audit.
// =============================================================================
//
// C11a-1 scope: send + persist + receive decision callbacks. Mediator
// agent-blocking flow (await decision before resolving the agent's call)
// lands in C11a-2.

export interface NotificationDeps {
  db: ForemanDb
  config: NotifyConfig
  /** Map of channel id → instance. Construction is the caller's responsibility
   *  so the service stays test-friendly (no real Telegram unless asked). */
  channels: Map<ChannelId, NotificationChannel>
  /** Optional — only required when a channel's token_ref hasn't been resolved
   *  upfront. The notify CLI uses the secret store to construct channel
   *  instances; this hook is mostly for future hot-reload. */
  secretStore?: SecretStore
}

export interface SendResult {
  notificationId: string
  /** Map of channel id → outcome on that channel. */
  outcomes: Map<ChannelId, ChannelOutcome>
}

export type ChannelOutcome =
  | { status: 'sent'; ref: ChannelMessageRef }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; reason: string }

export class NotificationService {
  private readonly listeners = new Map<
    ChannelId,
    (d: UserDecision) => Promise<void>
  >()
  private onDecision: ((d: UserDecision) => Promise<void>) | null = null

  constructor(private readonly deps: NotificationDeps) {}

  /** Dispatch a notification to every channel routed for its level. */
  async send(
    level: NotificationLevel,
    payload: Omit<Notification, 'id'>,
  ): Promise<SendResult> {
    const notificationId = ulid()
    const n: Notification = { id: notificationId, ...payload }
    const route = routeFor(this.deps.config, level)
    const outcomes = new Map<ChannelId, ChannelOutcome>()

    for (const channelName of route.channels) {
      const channelId = channelName as ChannelId
      const channel = this.deps.channels.get(channelId)

      if (!channel) {
        outcomes.set(channelId, {
          status: 'skipped',
          reason: 'channel not registered',
        })
        continue
      }
      if (!isChannelEnabled(this.deps.config, channelName)) {
        outcomes.set(channelId, {
          status: 'skipped',
          reason: 'channel disabled in notify.yaml',
        })
        continue
      }

      const sentAt = Date.now()
      try {
        const ref = await channel.send(n)
        outcomes.set(channelId, { status: 'sent', ref })
        this.persistSent({
          notificationId,
          requestId: n.requestId,
          level,
          channelId,
          body: n.body,
          sentAt,
          ref,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        outcomes.set(channelId, { status: 'failed', error: message })
        this.persistFailed({
          notificationId,
          requestId: n.requestId,
          level,
          channelId,
          body: n.body,
          sentAt,
          error: message,
        })
      }
    }

    return { notificationId, outcomes }
  }

  /** Subscribe a single handler that fires when ANY channel reports a
   *  decision. Used by C11a-2 to bridge OOB decisions into the existing
   *  `pending_approvals` flow. */
  onAnyDecision(handler: (d: UserDecision) => Promise<void>): void {
    this.onDecision = handler
  }

  /** Begin listening on each registered channel. Stops on `shutdown()`. */
  async startListening(): Promise<void> {
    for (const [channelId, channel] of this.deps.channels) {
      if (this.listeners.has(channelId)) continue
      const handler = async (d: UserDecision): Promise<void> => {
        this.recordDecision(d, channelId)
        if (this.onDecision) await this.onDecision(d)
      }
      this.listeners.set(channelId, handler)
      await channel.listen(handler)
    }
  }

  async shutdown(): Promise<void> {
    for (const channel of this.deps.channels.values()) {
      try {
        await channel.shutdown()
      } catch {
        // ignore — best-effort cleanup
      }
    }
    this.listeners.clear()
    this.onDecision = null
  }

  /** Fetch the most recent N notifications for `foreman notify status`. */
  recent(limit = 5): (typeof notifications.$inferSelect)[] {
    return this.deps.db
      .select()
      .from(notifications)
      .orderBy(notifications.sentAt)
      .limit(limit)
      .all()
      .reverse()
  }

  // ==========================================================================
  // Audit persistence
  // ==========================================================================

  private persistSent(args: {
    notificationId: string
    requestId: string | null
    level: NotificationLevel
    channelId: ChannelId
    body: string
    sentAt: number
    ref: ChannelMessageRef
  }): void {
    this.deps.db
      .insert(notifications)
      .values({
        id: args.notificationId,
        requestId: args.requestId,
        level: args.level,
        channel: args.channelId,
        body: args.body,
        status: 'sent',
        sentAt: args.sentAt,
      })
      .run()
    this.deps.db
      .insert(notificationMessages)
      .values({
        notificationId: args.notificationId,
        channel: args.channelId,
        channelMessageId: args.ref.channelMessageId,
        createdAt: args.sentAt,
      })
      .run()
  }

  private persistFailed(args: {
    notificationId: string
    requestId: string | null
    level: NotificationLevel
    channelId: ChannelId
    body: string
    sentAt: number
    error: string
  }): void {
    this.deps.db
      .insert(notifications)
      .values({
        id: args.notificationId,
        requestId: args.requestId,
        level: args.level,
        channel: args.channelId,
        body: args.body,
        status: 'failed',
        sentAt: args.sentAt,
        error: args.error,
      })
      .run()
  }

  private recordDecision(d: UserDecision, channelId: ChannelId): void {
    // Only the first decision wins — second decision on the same notification
    // (e.g. user also tapped in TUI) is dropped here so the audit row keeps
    // the original decided_by/decided_at.
    const row = this.deps.db
      .select()
      .from(notifications)
      .where(eq(notifications.id, d.notificationId))
      .get()
    if (!row || row.decision !== null) return
    this.deps.db
      .update(notifications)
      .set({
        status: 'delivered',
        decision:
          d.decision === 'allow_always'
            ? 'allow'
            : d.decision === 'deny_always'
              ? 'deny'
              : d.decision,
        decidedAt: d.decidedAt,
        decidedBy: `${channelId}:${d.decidedBy}`,
        deliveredAt: d.decidedAt,
      })
      .where(eq(notifications.id, d.notificationId))
      .run()
  }
}
