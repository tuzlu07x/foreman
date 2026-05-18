import { bus as defaultBus, type EventBus, type ForemanEventMap } from '../event-bus.js'
import { NotificationService } from './notification-service.js'
import {
  isAgentMuted,
  isSilenced,
  type NotifyState,
} from './notify-state.js'
import { renderApprovalNotification, renderResolvedFooter } from './render.js'
import type { ChannelId, UserDecision } from './types.js'

// =============================================================================
// NotificationBridge (#235 / C11a-2)
// =============================================================================
//
// Bridges the in-process event bus to the OOB notification pipeline. The
// mediator emits `approval:requested` → bridge sends a notification on every
// routed channel. The mediator (or another channel) emits `approval:resolved`
// → bridge updates the notification message ("Decided in TUI ✓").
// When a channel callback fires a decision, the bridge translates it back
// into an `approval:resolved` event on the same bus — the existing approval
// services (TUI Bus / cross-process DB) pick it up and the agent unblocks.
//
// Only one bridge per process; `start.ts` is the natural host.

export interface NotificationBridgeOptions {
  bus?: EventBus<ForemanEventMap>
  /** Callback that returns the current notify-state (silence + mutes). The
   *  bridge re-reads on every dispatch so `foreman notify silence 4h`
   *  takes effect without a process restart. */
  getState?: () => NotifyState
}

export class NotificationBridge {
  private readonly bus: EventBus<ForemanEventMap>
  private readonly getState: () => NotifyState
  private offRequested: (() => void) | null = null
  private offResolved: (() => void) | null = null
  private offDecided: (() => void) | null = null
  /** Maps requestId → notificationIds we've sent, so the resolved handler
   *  knows which messages to update. Cleared once a resolution lands. */
  private readonly outstanding = new Map<string, Set<string>>()

  constructor(
    private readonly service: NotificationService,
    opts: NotificationBridgeOptions = {},
  ) {
    this.bus = opts.bus ?? defaultBus
    this.getState =
      opts.getState ?? (() => ({ silencedUntil: null, mutedAgents: [] }))
  }

  async start(): Promise<void> {
    if (this.offRequested || this.offResolved) return

    // 1. Forward approval:requested → channel sends
    this.offRequested = this.bus.on('approval:requested', (req) => {
      this.handleRequested(req).catch(() => {
        // best-effort — channel-level failures are persisted in `notifications`
      })
    })

    // 2. When any decision (TUI / DB / OOB) lands, update the message
    //    that's sitting in the user's channel so they know it's resolved.
    this.offResolved = this.bus.on('approval:resolved', (res) => {
      this.handleResolved(res).catch(() => {
        // best-effort — message edit failure is non-fatal
      })
    })

    // 3. #383 — auto-deny alerts. When the risk engine auto-denies a call
    //    (no approval was ever asked), the user has no way to know their
    //    guardian actually caught something. Forward those as fire-and-
    //    forget notifications on the `risk_deny` route.
    this.offDecided = this.bus.on('request:decided', (req) => {
      this.handleAutoDenied(req).catch(() => {
        // best-effort — channel failures persisted in `notifications`
      })
    })

    // 4. When a channel callback fires, translate into an approval:resolved
    //    event so the rest of Foreman behaves as if the TUI modal answered.
    this.service.onAnyDecision(async (d) => {
      await this.handleOobDecision(d)
    })

    await this.service.startListening()
  }

  async stop(): Promise<void> {
    if (this.offRequested) {
      this.offRequested()
      this.offRequested = null
    }
    if (this.offResolved) {
      this.offResolved()
      this.offResolved = null
    }
    if (this.offDecided) {
      this.offDecided()
      this.offDecided = null
    }
    this.outstanding.clear()
    await this.service.shutdown()
  }

  // ============================================================================
  // Handlers
  // ============================================================================

  private async handleRequested(
    req: ForemanEventMap['approval:requested'],
  ): Promise<void> {
    const payload = renderApprovalNotification(req)
    const state = this.getState()
    // Skip muted source agents entirely — they never trigger OOB alerts.
    if (isAgentMuted(state, req.sourceAgent)) return
    // Silence window: drop everything except critical (the whole point of
    // silencing is to stop being woken up for medium/low risks).
    if (isSilenced(state) && payload.level !== 'critical') return

    const result = await this.service.send(payload.level, payload)

    // Track every notification id we created for this request so a later
    // resolution can update each channel's message.
    let set = this.outstanding.get(req.requestId)
    if (!set) {
      set = new Set()
      this.outstanding.set(req.requestId, set)
    }
    set.add(result.notificationId)
  }

  private async handleResolved(
    res: ForemanEventMap['approval:resolved'],
  ): Promise<void> {
    const ids = this.outstanding.get(res.requestId)
    if (!ids || ids.size === 0) return
    const footer = renderResolvedFooter(res)
    for (const notificationId of ids) {
      const ref = this.service.getMessageRef(notificationId)
      const row = this.service.getNotification(notificationId)
      if (!ref || !row) continue
      const channel = this.service.channelById(ref.channel as ChannelId)
      if (!channel) continue
      try {
        await channel.updateMessage(
          { channelMessageId: ref.channelMessageId },
          `${row.body}\n\n${footer}`,
        )
      } catch {
        // Message edit failed (Telegram rate limit, channel down, …) —
        // non-fatal; the decision is still recorded in the DB.
      }
    }
    this.outstanding.delete(res.requestId)
  }

  /**
   * #383 — Auto-deny alert. Fires after the risk engine slams the door
   * (decision === "denied", decidedBy starts with "policy:" or "risk:"
   * — NOT "user:" because the user already knows about their own
   * actions). Routes via `risk_deny` config so the user can disable in
   * notify.yaml if too noisy.
   */
  private async handleAutoDenied(
    req: ForemanEventMap['request:decided'],
  ): Promise<void> {
    if (req.decision !== 'denied') return
    // Don't notify on user-driven denials — the user just did it.
    if (req.decidedBy.startsWith('user')) return
    const state = this.getState()
    if (isAgentMuted(state, req.sourceAgent)) return
    // Silence window applies (the whole point of silence is no auto-pings).
    if (isSilenced(state)) return

    const reasons = req.riskReasons.length > 0
      ? req.riskReasons.slice(0, 3).join(', ')
      : 'no specific reason'
    const target =
      req.targetTool ?? req.targetAgent ?? 'unknown'
    const body =
      `🛡 Foreman blocked ${req.sourceAgent} from calling ${target}.\n` +
      `   Risk score: ${req.riskScore}/100 (${req.riskBucket})\n` +
      `   Reasons: ${reasons}`
    await this.service.send('risk_deny', {
      title: `Auto-denied: ${req.sourceAgent} → ${target}`,
      body,
      level: 'risk_deny',
      requestId: req.requestId,
      actions: [],
      agentBlocking: false,
    })
  }

  private async handleOobDecision(d: UserDecision): Promise<void> {
    const row = this.service.getNotification(d.notificationId)
    if (!row || !row.requestId) return
    // Translate channel verbs into the approval:resolved shape that
    // ApprovalBridge + BusApprovalService already understand.
    const decision = d.decision === 'allow' || d.decision === 'allow_always' ? 'allowed' : 'denied'
    const remember =
      d.decision === 'allow_always'
        ? 'allow'
        : d.decision === 'deny_always'
          ? 'deny'
          : undefined
    this.bus.emit('approval:resolved', {
      requestId: row.requestId,
      decision,
      remember,
      resolvedBy: 'user',
      // #302 — tag the channel so the mediator's decidedBy carries
      // "user:telegram" instead of bare "user".
      via: channelToVia(row.channel),
    })
  }
}

function channelToVia(
  channel: string,
):
  | 'telegram'
  | 'discord'
  | 'slack'
  | 'webhook'
  | undefined {
  switch (channel) {
    case 'telegram':
    case 'discord':
    case 'slack':
    case 'webhook':
      return channel
    default:
      return undefined
  }
}
