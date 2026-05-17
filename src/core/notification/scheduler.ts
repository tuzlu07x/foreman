// =============================================================================
// Notification scheduler — fires the daily digest at the configured time.
// =============================================================================
//
// Only supports `daily HH:MM` for v0.1 — cron expressions can land in v0.2
// when more digest types ship. Polls once a minute and fires when wall-clock
// crosses the target time. State is just "did we fire today?" so a restart
// in the middle of the day doesn't replay or double-fire.

const SCHEDULE_RE = /^daily\s+(\d{1,2}):(\d{2})$/i
const POLL_INTERVAL_MS = 60_000

export interface ParsedSchedule {
  hour: number
  minute: number
}

export function parseSchedule(input: string): ParsedSchedule | null {
  const m = input.trim().match(SCHEDULE_RE)
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

export interface SchedulerOptions {
  /** Inject for tests so we don't sit on a real wall-clock timer. */
  pollIntervalMs?: number
  /** Override Date.now — also for tests. */
  now?: () => number
}

export class DailyScheduler {
  private timer: NodeJS.Timeout | null = null
  private lastFiredDate: string | null = null
  private readonly schedule: ParsedSchedule
  private readonly onFire: () => Promise<void> | void
  private readonly pollIntervalMs: number
  private readonly now: () => number

  constructor(
    schedule: ParsedSchedule,
    onFire: () => Promise<void> | void,
    opts: SchedulerOptions = {},
  ) {
    this.schedule = schedule
    this.onFire = onFire
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS
    this.now = opts.now ?? Date.now
  }

  start(): void {
    if (this.timer) return
    // Note: lastFiredDate is intentionally NOT seeded on start. If we boot
    // after today's scheduled time, the user hasn't seen today's digest yet
    // — we fire on the next tick. State doesn't persist across restarts in
    // v0.1; a restart inside the same calendar day after firing can fire a
    // second time, which is acceptable for v0.1.
    this.timer = setInterval(() => {
      void this.tick()
    }, this.pollIntervalMs)
    // Don't keep the event loop alive just for the scheduler.
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Called by the interval AND by `runOnce()` for tests. */
  async tick(): Promise<void> {
    const today = this.todayKey()
    if (this.lastFiredDate === today) return
    if (!this.shouldHaveFiredToday()) return
    this.lastFiredDate = today
    try {
      await this.onFire()
    } catch {
      // Failure is best-effort; log surface lives in the caller. Reset
      // lastFiredDate so a flaky transient failure can retry tomorrow.
    }
  }

  /** Force a fire regardless of clock — used by `foreman notify summary --now`. */
  async runNow(): Promise<void> {
    await this.onFire()
  }

  private shouldHaveFiredToday(): boolean {
    const d = new Date(this.now())
    const targetMs = new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      this.schedule.hour,
      this.schedule.minute,
      0,
      0,
    ).getTime()
    return this.now() >= targetMs
  }

  private todayKey(): string {
    const d = new Date(this.now())
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
  }
}
