import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CountdownTicker } from '../../../src/core/notification/countdown-ticker.js'
import type {
  ChannelMessageRef,
  Notification,
  NotificationChannel,
  UserDecision,
} from '../../../src/core/notification/types.js'

// =============================================================================
// CountdownTicker (#525)
//
// All tests inject `nowFn` so the deadline math is deterministic without
// touching real wall clock. Tests call `.tick()` directly instead of
// waiting for the interval — the timer plumbing is verified once and
// the behavioural tests focus on register / unregister / resolve flow.
// =============================================================================

class FakeChannel implements NotificationChannel {
  readonly id = 'telegram' as const
  updateCalls: { ref: ChannelMessageRef; body: string }[] = []
  async isReady(): Promise<boolean> {
    return true
  }
  async send(_n: Notification): Promise<ChannelMessageRef> {
    return { channelMessageId: 'msg-1' }
  }
  async updateMessage(ref: ChannelMessageRef, body: string): Promise<void> {
    this.updateCalls.push({ ref, body })
  }
  async listen(_h: (d: UserDecision) => Promise<void>): Promise<void> {
    // no-op for these tests
  }
  async shutdown(): Promise<void> {
    /* no-op */
  }
}

describe('CountdownTicker', () => {
  let now: number
  let channel: FakeChannel
  let ticker: CountdownTicker

  beforeEach(() => {
    now = 1_700_000_000_000
    channel = new FakeChannel()
    ticker = new CountdownTicker({ nowFn: () => now })
  })

  afterEach(() => {
    ticker.stop()
  })

  function registerAt(approvalId: string, deadlineFromNowMs: number): void {
    ticker.register({
      approvalId,
      channel,
      ref: { channelMessageId: `msg-${approvalId}` },
      // Body includes the original countdown tail formatCountdownLine put there;
      // the ticker replaces just that tail on each tick.
      body:
        `*Approval needed*\n\nrisk: 70/100\n\n` +
        `⏱ Auto-deny in 10m — tap [Deny] to block now.`,
      deadlineMs: now + deadlineFromNowMs,
    })
  }

  it('registers an in-flight approval (size reflects registry)', () => {
    expect(ticker.size()).toBe(0)
    registerAt('a', 10 * 60_000)
    expect(ticker.size()).toBe(1)
    registerAt('b', 5 * 60_000)
    expect(ticker.size()).toBe(2)
  })

  it('unregister removes the entry + stops ticking it', async () => {
    registerAt('a', 10 * 60_000)
    ticker.unregister('a')
    expect(ticker.size()).toBe(0)
    await ticker.tick()
    expect(channel.updateCalls).toHaveLength(0)
  })

  it('tick edits each registered message with the updated tail', async () => {
    registerAt('a', 10 * 60_000) // 10 min remaining
    now += 60_000 // 1 min passes → 9 min remaining
    await ticker.tick()
    expect(channel.updateCalls).toHaveLength(1)
    expect(channel.updateCalls[0]!.body).toContain('Auto-deny in 9m')
    // Original body prefix preserved — countdown tail replaced, not stacked.
    expect(channel.updateCalls[0]!.body).toContain('risk: 70/100')
    // No double-tail (only one ⏱ line in the body).
    expect((channel.updateCalls[0]!.body.match(/⏱/g) ?? []).length).toBe(1)
  })

  it('switches to second-level tail in the last minute', async () => {
    registerAt('a', 30_000) // 30s remaining → under-60s mode
    await ticker.tick()
    expect(channel.updateCalls[0]!.body).toContain('Auto-deny in 30s')
  })

  it('renders "Timed out" when deadline has passed + does NOT re-edit on the next tick', async () => {
    registerAt('a', 60_000)
    now += 90_000 // 30s past deadline
    await ticker.tick()
    expect(channel.updateCalls).toHaveLength(1)
    expect(channel.updateCalls[0]!.body).toContain('Timed out')
    // Second tick: entry is marked expired → no re-edit.
    await ticker.tick()
    expect(channel.updateCalls).toHaveLength(1)
  })

  it('resolve() strips the countdown tail + appends the final footer', async () => {
    registerAt('a', 10 * 60_000)
    await ticker.resolve('a', '✓ Allowed by you')
    expect(channel.updateCalls).toHaveLength(1)
    expect(channel.updateCalls[0]!.body).not.toContain('⏱')
    expect(channel.updateCalls[0]!.body).toContain('✓ Allowed by you')
    expect(channel.updateCalls[0]!.body).toContain('risk: 70/100')
    // Entry is gone — subsequent ticks don't touch it.
    expect(ticker.size()).toBe(0)
    await ticker.tick()
    expect(channel.updateCalls).toHaveLength(1)
  })

  it('resolve() on an unknown approval id is a no-op (not an error)', async () => {
    await ticker.resolve('ghost', 'whatever')
    expect(channel.updateCalls).toHaveLength(0)
  })

  it('multiple registered approvals all get edited on one tick (shared interval)', async () => {
    registerAt('a', 10 * 60_000)
    registerAt('b', 5 * 60_000)
    registerAt('c', 60_000)
    await ticker.tick()
    expect(channel.updateCalls).toHaveLength(3)
  })

  it('continues ticking remaining entries when one channel.updateMessage throws', async () => {
    // First registered entry uses a channel whose updateMessage throws.
    const failingChannel = new FakeChannel()
    failingChannel.updateMessage = async () => {
      throw new Error('telegram down')
    }
    ticker.register({
      approvalId: 'a',
      channel: failingChannel,
      ref: { channelMessageId: 'msg-a' },
      body: `*A*\n\n⏱ Auto-deny in 10m — tap [Deny] to block now.`,
      deadlineMs: now + 10 * 60_000,
    })
    registerAt('b', 5 * 60_000)
    await ticker.tick()
    // The healthy channel still got its edit.
    expect(channel.updateCalls).toHaveLength(1)
  })

  it('start()/stop() wire + unwire the interval timer', () => {
    const setIntervalSpy = vi.fn(() => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setInterval>)
    const clearIntervalSpy = vi.fn()
    const t = new CountdownTicker({
      nowFn: () => now,
      setIntervalFn: setIntervalSpy as unknown as typeof setInterval,
      clearIntervalFn: clearIntervalSpy as unknown as typeof clearInterval,
    })
    t.start()
    expect(setIntervalSpy).toHaveBeenCalledOnce()
    // Idempotent — second start does NOT register a second timer.
    t.start()
    expect(setIntervalSpy).toHaveBeenCalledOnce()
    t.stop()
    expect(clearIntervalSpy).toHaveBeenCalledOnce()
  })

  it('appends the tail when the body has no existing countdown line (legacy / non-Telegram body)', async () => {
    ticker.register({
      approvalId: 'legacy',
      channel,
      ref: { channelMessageId: 'msg-x' },
      body: '*Approval needed*\n\nrisk: 50/100', // no ⏱ tail
      deadlineMs: now + 10 * 60_000,
    })
    await ticker.tick()
    expect(channel.updateCalls[0]!.body).toContain('Auto-deny in')
    // Body kept intact; tail appended.
    expect(channel.updateCalls[0]!.body).toContain('risk: 50/100')
  })
})
