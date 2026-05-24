import { formatCountdownLine } from './render.js'
import type { ChannelMessageRef, NotificationChannel } from './types.js'

// =============================================================================
// CountdownTicker (#525)
// =============================================================================
//
// Edits each in-flight approval message every `tickIntervalMs` to refresh
// the "⏱ Auto-deny in Xm Ys" tail. One shared interval scans the
// registry on each tick — N approvals × 1 timer instead of N timers.
//
// Why a single tick and not per-approval setInterval:
//   * Telegram rate-limits message edits (~1/sec per chat globally, ~20/min
//     per message). Minute resolution keeps us comfortably under both caps
//     while still feeling live.
//   * One interval is easier to shut down cleanly (process exit, test
//     teardown) than N adhoc timers leaking handles.
//
// Body reuse: the initial `channel.send()` already baked a countdown line
// at the bottom of the message body. The ticker keeps a copy of that body
// and replaces just the tail on each update — no need to re-render the
// full notification payload.

const DEFAULT_TICK_INTERVAL_MS = 60_000

interface RegisteredApproval {
  channel: NotificationChannel
  ref: ChannelMessageRef
  /** Body as it was originally rendered + sent — includes the first
   *  countdown line at the tail. The ticker replaces that tail with a
   *  freshly-rendered one each tick. */
  body: string
  deadlineMs: number
  /** What auto-resolves the approval when the deadline expires.
   *  v0.1.0 always uses `deny`; the field exists so a per-route
   *  default-action override (#525 out-of-scope) can land later. */
  decision: 'allow' | 'deny'
  /** Set true once the final timeout edit has been pushed so the next
   *  tick doesn't re-edit the same expired message in a loop. */
  expired: boolean
}

export interface CountdownTickerOptions {
  tickIntervalMs?: number
  nowFn?: () => number
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
}

export interface CountdownRegistration {
  approvalId: string
  channel: NotificationChannel
  ref: ChannelMessageRef
  body: string
  deadlineMs: number
  decision?: 'allow' | 'deny'
}

/** Shared per-process registry that tracks in-flight approval messages
 *  + edits each to refresh the countdown tail. The notification bridge
 *  calls `register()` after sending an approval and `unregister()`
 *  (or `resolve()` for a final edit) when the bus reports the
 *  approval was resolved. */
export class CountdownTicker {
  private readonly tickIntervalMs: number
  private readonly now: () => number
  private readonly setIntervalFn: typeof setInterval
  private readonly clearIntervalFn: typeof clearInterval
  private readonly registry = new Map<string, RegisteredApproval>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(opts: CountdownTickerOptions = {}) {
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
    this.now = opts.nowFn ?? Date.now
    this.setIntervalFn = opts.setIntervalFn ?? setInterval
    this.clearIntervalFn = opts.clearIntervalFn ?? clearInterval
  }

  start(): void {
    if (this.timer) return
    this.timer = this.setIntervalFn(() => {
      void this.tick()
    }, this.tickIntervalMs)
    // .unref() so a stray ticker doesn't keep the process alive at
    // shutdown. Guarded — injected fake timers in tests may not have it.
    const handle = this.timer as { unref?: () => void } | null
    if (handle && typeof handle.unref === 'function') handle.unref()
  }

  stop(): void {
    if (this.timer) {
      this.clearIntervalFn(this.timer)
      this.timer = null
    }
    this.registry.clear()
  }

  register(input: CountdownRegistration): void {
    // Re-registering the same id is idempotent (replaces — bridge
    // should normally not double-register, but defensive).
    this.registry.set(input.approvalId, {
      channel: input.channel,
      ref: input.ref,
      body: input.body,
      deadlineMs: input.deadlineMs,
      decision: input.decision ?? 'deny',
      expired: false,
    })
  }

  unregister(approvalId: string): void {
    this.registry.delete(approvalId)
  }

  /** Final edit when an approval resolves before its deadline (user
   *  tapped Allow / Deny, or a different channel resolved it). The
   *  countdown tail is stripped + replaced with a one-line footer the
   *  bridge supplies; the registration is then dropped. */
  async resolve(approvalId: string, footer: string): Promise<void> {
    const entry = this.registry.get(approvalId)
    this.registry.delete(approvalId)
    if (!entry) return
    const stripped = stripCountdownTail(entry.body)
    try {
      await entry.channel.updateMessage(entry.ref, `${stripped}\n\n${footer}`)
    } catch {
      // Message edit failure is non-fatal; the decision is still
      // recorded in the audit log and the original message body
      // already showed what was at stake.
    }
  }

  /** Exposed for tests so they can advance the clock + tick deterministically
   *  without waiting on the real interval. */
  async tick(): Promise<void> {
    const now = this.now()
    const work: Promise<void>[] = []
    for (const [approvalId, entry] of this.registry) {
      if (entry.expired) continue
      const remaining = entry.deadlineMs - now
      const newTail = formatCountdownLine(entry.deadlineMs, now, entry.decision)
      const newBody = replaceCountdownTail(entry.body, newTail)
      work.push(
        entry.channel
          .updateMessage(entry.ref, newBody)
          .catch(() => {
            // best-effort — channel down / rate-limited; try again next tick
          }),
      )
      if (remaining <= 0) {
        entry.expired = true
        // Keep the entry around for one more cycle so a late `resolve()`
        // can still strip + replace, but mark it expired so the next
        // tick doesn't re-edit. A subsequent `unregister()` from the
        // resolution path will drop it cleanly.
      }
    }
    await Promise.all(work)
  }

  /** Test helper — registry size (number of in-flight approvals
   *  currently being ticked). */
  size(): number {
    return this.registry.size
  }
}

/** Replace the trailing "⏱ …" line with `newTail`. If the body has no
 *  existing countdown line (legacy notifications, custom channel
 *  templates) the tail is appended after a blank-line separator. */
function replaceCountdownTail(body: string, newTail: string): string {
  const lastNewline = body.lastIndexOf('\n⏱')
  if (lastNewline === -1) {
    return body.endsWith('\n') ? `${body}\n${newTail}` : `${body}\n\n${newTail}`
  }
  return `${body.slice(0, lastNewline)}\n${newTail}`
}

/** Drop the trailing countdown line entirely. Used by `resolve()` so the
 *  final "✓ Decided" footer doesn't sit underneath a stale countdown. */
function stripCountdownTail(body: string): string {
  const idx = body.lastIndexOf('\n⏱')
  if (idx === -1) return body
  return body.slice(0, idx)
}
