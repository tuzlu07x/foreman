import {
  bus as defaultBus,
  type EventBus,
  type ForemanEventMap,
} from '../event-bus.js'
import type { SessionInfo, SessionManager } from '../session.js'

// =============================================================================
// SessionProgressTicker (#523)
// =============================================================================
//
// Emits `session:progress` events for active sessions on a fixed cadence —
// "still working: 14 turn, 1h 18m elapsed, last action was hermes → read_file".
//
// Two timing knobs:
//
//   * scanIntervalMs (default 5 min) — how often the ticker wakes up to look
//     at active sessions. Keep low enough that progressIntervalMs is
//     approximated, high enough that we don't burn CPU on a busy machine.
//   * progressIntervalMs (default 15 min) — minimum wall-clock between two
//     progress events for the same session. The first progress for a session
//     fires at `startedAt + progressIntervalMs`, NOT immediately on start —
//     a session that finishes in <15 min gets a clean "started + completed"
//     pair without an extra noisy mid-progress ping.
//
// recentDecisions are captured by subscribing to `request:decided` and
// keeping a per-session ring buffer (newest first, capped at 3). When a
// session completes its buffer is dropped — long-lived ticker, bounded
// memory regardless of how many sessions Foreman has historically seen.
//
// Tests inject `nowFn` so they don't have to wait for real wall clock.

const DEFAULT_SCAN_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_PROGRESS_INTERVAL_MS = 15 * 60 * 1000
const RECENT_DECISIONS_CAP = 3

export interface SessionProgressTickerOptions {
  bus?: EventBus<ForemanEventMap>
  /** How often the ticker scans active sessions. */
  scanIntervalMs?: number
  /** Min wall-clock between two progress events for the same session. */
  progressIntervalMs?: number
  /** Injectable clock — tests pass a controllable Date.now. */
  nowFn?: () => number
  /** Injectable setInterval / clearInterval pair so tests don't have to
   *  hold real timers. Defaults to the global Node implementations. */
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
}

export class SessionProgressTicker {
  private readonly bus: EventBus<ForemanEventMap>
  private readonly scanIntervalMs: number
  private readonly progressIntervalMs: number
  private readonly now: () => number
  private readonly setIntervalFn: typeof setInterval
  private readonly clearIntervalFn: typeof clearInterval
  /** Last time we emitted a progress event for the session, OR the session's
   *  startedAt if we haven't emitted one yet. Compared against `now() -
   *  progressIntervalMs` on every scan. */
  private readonly lastEmitAt = new Map<string, number>()
  /** Newest-first ring buffer per session, capped at RECENT_DECISIONS_CAP. */
  private readonly recentDecisions = new Map<
    string,
    ForemanEventMap['session:progress']['recentDecisions']
  >()
  private timer: ReturnType<typeof setInterval> | null = null
  private offDecided: (() => void) | null = null
  private offCompleted: (() => void) | null = null

  constructor(
    private readonly sessions: SessionManager,
    opts: SessionProgressTickerOptions = {},
  ) {
    this.bus = opts.bus ?? defaultBus
    this.scanIntervalMs = opts.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS
    this.progressIntervalMs =
      opts.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS
    this.now = opts.nowFn ?? Date.now
    this.setIntervalFn = opts.setIntervalFn ?? setInterval
    this.clearIntervalFn = opts.clearIntervalFn ?? clearInterval
  }

  start(): void {
    if (this.timer) return
    // Subscribe to mediator decisions so the next progress push can quote
    // what the agent just did. Ring buffer is bounded so even a 1000-call
    // session leaves at most 3 entries per active session in memory.
    this.offDecided = this.bus.on('request:decided', (req) => {
      if (!req.sessionId) return
      this.recordDecision(req)
    })
    // When a session completes / halts, drop its buffer so we don't leak
    // memory for long-lived Foreman processes that have seen thousands of
    // sessions over their lifetime.
    this.offCompleted = this.bus.on('session:completed', (e) => {
      this.lastEmitAt.delete(e.sessionId)
      this.recentDecisions.delete(e.sessionId)
    })
    this.timer = this.setIntervalFn(() => {
      this.scan()
    }, this.scanIntervalMs)
    // Most Node setIntervals are refs'd by default; .unref() so a stray
    // ticker doesn't keep the process alive at shutdown. Guarded — the
    // injected fake timer in tests may not have .unref().
    const handle = this.timer as { unref?: () => void } | null
    if (handle && typeof handle.unref === 'function') handle.unref()
  }

  stop(): void {
    if (this.timer) {
      this.clearIntervalFn(this.timer)
      this.timer = null
    }
    if (this.offDecided) {
      this.offDecided()
      this.offDecided = null
    }
    if (this.offCompleted) {
      this.offCompleted()
      this.offCompleted = null
    }
    this.lastEmitAt.clear()
    this.recentDecisions.clear()
  }

  /** Run a single scan + emit pass. Exposed for tests so they don't have to
   *  wait for the interval to fire. */
  scan(): void {
    const now = this.now()
    const active = this.sessions.getActive()
    for (const info of active) {
      if (this.shouldEmit(info, now)) {
        this.emitProgress(info, now)
      }
    }
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private recordDecision(
    req: ForemanEventMap['request:decided'],
  ): void {
    if (!req.sessionId) return
    const existing = this.recentDecisions.get(req.sessionId) ?? []
    const next = [
      {
        sourceAgent: req.sourceAgent,
        targetTool: req.targetTool,
        targetAgent: req.targetAgent,
        decision: req.decision as 'allowed' | 'denied' | 'asked',
      },
      ...existing,
    ].slice(0, RECENT_DECISIONS_CAP)
    this.recentDecisions.set(req.sessionId, next)
  }

  private shouldEmit(info: SessionInfo, now: number): boolean {
    const last = this.lastEmitAt.get(info.id) ?? info.startedAt
    return now - last >= this.progressIntervalMs
  }

  private emitProgress(info: SessionInfo, now: number): void {
    const recent = this.recentDecisions.get(info.id) ?? []
    this.bus.emit('session:progress', {
      sessionId: info.id,
      turnCount: info.messageCount,
      tokenCount: info.tokenCount,
      recentDecisions: recent,
      elapsedMs: now - info.startedAt,
      emittedAt: now,
    })
    this.lastEmitAt.set(info.id, now)
  }
}
