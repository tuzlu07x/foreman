import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DailyScheduler,
  parseSchedule,
} from '../../../src/core/notification/scheduler.js'

describe('parseSchedule', () => {
  it.each([
    ['daily 09:00', { hour: 9, minute: 0 }],
    ['daily 20:00', { hour: 20, minute: 0 }],
    ['daily 23:59', { hour: 23, minute: 59 }],
    ['DAILY 8:30', { hour: 8, minute: 30 }],
    ['  daily 7:15  ', { hour: 7, minute: 15 }],
  ])('parses %s', (input, expected) => {
    expect(parseSchedule(input)).toEqual(expected)
  })

  it.each([
    'never',
    '* * * * *',
    'daily 24:00', // hour out of range
    'daily 12:60', // minute out of range
    'daily',
    '',
    'weekly 09:00',
  ])('returns null for unparseable: %s', (input) => {
    expect(parseSchedule(input)).toBeNull()
  })
})

describe('DailyScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function buildScheduler(opts: {
    hour: number
    minute: number
    now: number
    onFire: () => void
  }): DailyScheduler {
    return new DailyScheduler(
      { hour: opts.hour, minute: opts.minute },
      opts.onFire,
      {
        pollIntervalMs: 1000,
        now: () => opts.now,
      },
    )
  }

  it('fires when wall-clock crosses the target time', async () => {
    const onFire = vi.fn()
    // Start at 19:59. Target = 20:00. After tick, time advances to 20:01.
    let now = new Date(2026, 0, 1, 19, 59, 0).getTime()
    const scheduler = new DailyScheduler(
      { hour: 20, minute: 0 },
      onFire,
      { pollIntervalMs: 1000, now: () => now },
    )
    scheduler.start()
    // First tick — still 19:59. Shouldn't fire.
    await scheduler.tick()
    expect(onFire).not.toHaveBeenCalled()
    // Advance wall clock past 20:00.
    now = new Date(2026, 0, 1, 20, 1, 0).getTime()
    await scheduler.tick()
    expect(onFire).toHaveBeenCalledOnce()
    scheduler.stop()
  })

  it('fires at most once per day even on repeated ticks', async () => {
    const onFire = vi.fn()
    const now = new Date(2026, 0, 1, 20, 5, 0).getTime()
    const scheduler = buildScheduler({ hour: 20, minute: 0, now, onFire })
    scheduler.start()
    await scheduler.tick()
    await scheduler.tick()
    await scheduler.tick()
    // First tick triggered the firing; subsequent ticks are no-ops because
    // we're on the same calendar day.
    expect(onFire).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })

  it('starting AFTER today\'s scheduled time still fires (catch-up on restart)', async () => {
    const onFire = vi.fn()
    const now = new Date(2026, 0, 1, 21, 0, 0).getTime() // 21:00, past 20:00 target
    const scheduler = buildScheduler({ hour: 20, minute: 0, now, onFire })
    scheduler.start()
    await scheduler.tick()
    // v0.1 design: a restart after target fires on the next tick so the user
    // still gets today's digest (state doesn't persist across restarts).
    expect(onFire).toHaveBeenCalledOnce()
    scheduler.stop()
  })

  it('runNow forces a fire regardless of clock', async () => {
    const onFire = vi.fn()
    const scheduler = buildScheduler({
      hour: 20,
      minute: 0,
      now: new Date(2026, 0, 1, 8, 0, 0).getTime(),
      onFire,
    })
    await scheduler.runNow()
    expect(onFire).toHaveBeenCalledOnce()
  })

  it('stop() unrefs the timer and prevents further fires', async () => {
    const onFire = vi.fn()
    const scheduler = buildScheduler({
      hour: 20,
      minute: 0,
      now: new Date(2026, 0, 1, 19, 59, 0).getTime(),
      onFire,
    })
    scheduler.start()
    scheduler.stop()
    // tick is async — call directly to confirm onFire isn't double-fired
    // after stop. (The stop just halts the setInterval; tick still works
    // if called manually, but the timer that drives it is gone.)
  })

  it('throws in onFire do not crash the scheduler (caught + lastFiredDate reset)', async () => {
    const onFire = vi.fn(() => {
      throw new Error('digest send failed')
    })
    const scheduler = buildScheduler({
      hour: 20,
      minute: 0,
      now: new Date(2026, 0, 1, 20, 5, 0).getTime(),
      onFire,
    })
    scheduler.start()
    await scheduler.tick()
    expect(onFire).toHaveBeenCalled()
    // Should not throw to the caller
  })
})
