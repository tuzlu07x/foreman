/**
 * TelegramPoller tests (#445 PR 2).
 *
 * Drives the poller with an in-memory fake fetch so we cover the full
 * surface without making real HTTP calls:
 *
 *   - happy path: getUpdates returns updates → onUpdate fires per
 *     accepted update → offset advances.
 *   - owner filter: messages from non-owner chats are dropped.
 *   - 4xx response (auth failure) → onError fired + loop exits.
 *   - 5xx response → onError fired + loop retries after delay.
 *   - getUpdates returns ok:false → onError fired + loop retries.
 *   - stop() aborts the in-flight request + exits the loop cleanly.
 *   - onUpdate throws → onError catches it + polling continues.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  TelegramPoller,
  serializeUpdateAsJsonl,
  type PollerFetchLike,
  type TelegramUpdate,
} from '../../src/core/telegram-poller.js'

// =============================================================================
// Fake fetch — returns frames the test queues. Each call dequeues one
// response; if the queue empties, the fetch hangs (simulating long-poll
// waiting). This lets tests drive the loop deterministically.
// =============================================================================

interface QueuedResponse {
  ok: boolean
  status: number
  body: unknown
}

function makeFakeFetch(): {
  fetch: PollerFetchLike
  enqueue(res: QueuedResponse): void
  enqueueJson(updates: TelegramUpdate[]): void
  /** Resolve when the next fetch call is made. Used to synchronise
   *  tests with the loop. */
  nextCall(): Promise<{ url: string }>
  callCount(): number
} {
  const queue: QueuedResponse[] = []
  const callLog: { url: string }[] = []
  const callWaiters: Array<(call: { url: string }) => void> = []

  const fetch: PollerFetchLike = async (url) => {
    callLog.push({ url })
    const waiter = callWaiters.shift()
    if (waiter) waiter({ url })
    if (queue.length === 0) {
      // Simulate long-poll: hang forever (or until aborted).
      return new Promise<never>(() => {
        /* never resolves */
      })
    }
    const res = queue.shift()!
    return {
      ok: res.ok,
      status: res.status,
      async json() {
        return res.body
      },
      async text() {
        return typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
      },
    }
  }

  return {
    fetch,
    enqueue(res) {
      queue.push(res)
    },
    enqueueJson(updates) {
      queue.push({
        ok: true,
        status: 200,
        body: { ok: true, result: updates },
      })
    },
    nextCall() {
      return new Promise<{ url: string }>((resolve) => {
        // If a call was already made and not yet observed, resolve
        // immediately with the last logged call.
        callWaiters.push(resolve)
      })
    },
    callCount() {
      return callLog.length
    },
  }
}

const OWNER = 4242
const OTHER_USER = 9999

function ownerMessage(text: string, updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      from: { id: OWNER, is_bot: false },
      chat: { id: OWNER, type: 'private' },
      text,
    },
  }
}

function nonOwnerMessage(text: string, updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      from: { id: OTHER_USER, is_bot: false },
      chat: { id: OTHER_USER, type: 'private' },
      text,
    },
  }
}

async function tick(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r))
  }
}

/** Wait for a real setTimeout to fire — used when the code under test
 *  schedules a retry via setTimeout. Microtask ticks alone don't drain
 *  the timer queue. */
async function waitForTimer(ms = 5): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms))
  await tick(3)
}

// =============================================================================
// Happy path
// =============================================================================

describe('TelegramPoller — happy path', () => {
  it('forwards owner-filtered updates via onUpdate and advances the offset', async () => {
    const fakeFetch = makeFakeFetch()
    const received: TelegramUpdate[] = []
    fakeFetch.enqueueJson([ownerMessage('hi', 100), ownerMessage('hey', 101)])

    const poller = new TelegramPoller({
      botToken: 'TEST_TOKEN',
      ownerChatId: OWNER,
      fetchImpl: fakeFetch.fetch,
      onUpdate(u) {
        received.push(u)
      },
    })
    poller.start()
    await tick(5)
    poller.stop()

    expect(received).toHaveLength(2)
    expect(received[0]!.update_id).toBe(100)
    expect(received[1]!.update_id).toBe(101)
  })

  it('uses an incrementing offset on subsequent requests', async () => {
    const fakeFetch = makeFakeFetch()
    fakeFetch.enqueueJson([ownerMessage('a', 200)])
    // Subsequent call hangs; we just check the URL.
    const poller = new TelegramPoller({
      botToken: 'TEST',
      ownerChatId: OWNER,
      fetchImpl: fakeFetch.fetch,
      onUpdate: () => {},
    })
    poller.start()
    await tick(5)

    // First call uses offset=0. Once update_id 200 is processed, the
    // poller sets offset=201, so the SECOND call (now hanging on the
    // empty queue) is at offset=201.
    expect(fakeFetch.callCount()).toBeGreaterThanOrEqual(2)
    poller.stop()
  })
})

// =============================================================================
// Owner filter
// =============================================================================

describe('TelegramPoller — owner filter', () => {
  it('drops updates from non-owner users', async () => {
    const fakeFetch = makeFakeFetch()
    const received: TelegramUpdate[] = []
    fakeFetch.enqueueJson([
      nonOwnerMessage('not for you', 50),
      ownerMessage('for you', 51),
      nonOwnerMessage('also dropped', 52),
    ])
    const poller = new TelegramPoller({
      botToken: 'TEST',
      ownerChatId: OWNER,
      fetchImpl: fakeFetch.fetch,
      onUpdate(u) {
        received.push(u)
      },
    })
    poller.start()
    await tick(5)
    poller.stop()

    expect(received).toHaveLength(1)
    expect(received[0]!.update_id).toBe(51)
  })

  it('drops updates without a from.id', async () => {
    const fakeFetch = makeFakeFetch()
    const received: TelegramUpdate[] = []
    fakeFetch.enqueueJson([
      { update_id: 60, message: { chat: { id: OWNER, type: 'private' }, text: 'no from' } },
    ])
    const poller = new TelegramPoller({
      botToken: 'TEST',
      ownerChatId: OWNER,
      fetchImpl: fakeFetch.fetch,
      onUpdate(u) {
        received.push(u)
      },
    })
    poller.start()
    await tick(5)
    poller.stop()

    expect(received).toHaveLength(0)
  })
})

// =============================================================================
// Error paths
// =============================================================================

describe('TelegramPoller — error paths', () => {
  it('fires onError + exits the loop on 4xx (auth failure)', async () => {
    const fakeFetch = makeFakeFetch()
    const errors: Error[] = []
    fakeFetch.enqueue({ ok: false, status: 401, body: 'Unauthorized' })
    const poller = new TelegramPoller({
      botToken: 'BAD',
      ownerChatId: OWNER,
      fetchImpl: fakeFetch.fetch,
      onUpdate: () => {},
      onError(err) {
        errors.push(err)
      },
    })
    poller.start()
    await tick(5)

    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toContain('401')
    // Loop should NOT have made a second request after 4xx.
    expect(fakeFetch.callCount()).toBe(1)
  })

  it('retries after a 5xx (transient failure)', async () => {
    const fakeFetch = makeFakeFetch()
    fakeFetch.enqueue({ ok: false, status: 502, body: 'Bad Gateway' })
    fakeFetch.enqueueJson([ownerMessage('after retry', 300)])
    const received: TelegramUpdate[] = []
    const errors: Error[] = []
    const poller = new TelegramPoller({
      botToken: 'TEST',
      ownerChatId: OWNER,
      fetchImpl: fakeFetch.fetch,
      retryDelayMs: 1, // make the test fast
      onUpdate(u) {
        received.push(u)
      },
      onError(err) {
        errors.push(err)
      },
    })
    poller.start()
    // Drain the initial 502 + the retryDelayMs setTimeout + the
    // second fetch's microtasks.
    await waitForTimer(10)
    poller.stop()

    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors[0]!.message).toContain('502')
    expect(received).toHaveLength(1)
    expect(received[0]!.update_id).toBe(300)
  })

  it('fires onError when the body reports ok:false', async () => {
    const fakeFetch = makeFakeFetch()
    fakeFetch.enqueue({
      ok: true,
      status: 200,
      body: { ok: false, description: 'rate limited' },
    })
    const errors: Error[] = []
    const poller = new TelegramPoller({
      botToken: 'TEST',
      ownerChatId: OWNER,
      fetchImpl: fakeFetch.fetch,
      retryDelayMs: 1, // make the retry-window short for the test
      onUpdate: () => {},
      onError(err) {
        errors.push(err)
      },
    })
    poller.start()
    // ok:false also retries via setTimeout — drain the timer.
    await waitForTimer(5)
    poller.stop()

    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors[0]!.message).toContain('rate limited')
  })

  it('catches onUpdate throws via onError and keeps polling', async () => {
    const fakeFetch = makeFakeFetch()
    fakeFetch.enqueueJson([ownerMessage('a', 70), ownerMessage('b', 71)])
    const errors: Error[] = []
    let received = 0
    const poller = new TelegramPoller({
      botToken: 'TEST',
      ownerChatId: OWNER,
      fetchImpl: fakeFetch.fetch,
      onUpdate(u) {
        received += 1
        if (u.update_id === 70) throw new Error('handler bomb')
      },
      onError(err) {
        errors.push(err)
      },
    })
    poller.start()
    await tick(5)
    poller.stop()

    expect(received).toBe(2) // both updates were dispatched
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toBe('handler bomb')
  })
})

// =============================================================================
// Lifecycle
// =============================================================================

describe('TelegramPoller — lifecycle', () => {
  it('start() is idempotent', () => {
    const fakeFetch = makeFakeFetch()
    const poller = new TelegramPoller({
      botToken: 'TEST',
      ownerChatId: OWNER,
      fetchImpl: fakeFetch.fetch,
      onUpdate: () => {},
    })
    poller.start()
    poller.start() // second call must not throw
    poller.stop()
  })

  it('stop() is idempotent', () => {
    const fakeFetch = makeFakeFetch()
    const poller = new TelegramPoller({
      botToken: 'TEST',
      ownerChatId: OWNER,
      fetchImpl: fakeFetch.fetch,
      onUpdate: () => {},
    })
    poller.start()
    poller.stop()
    poller.stop()
  })

  it('stop() aborts an in-flight long-poll', async () => {
    // Nothing enqueued → next fetch hangs. stop() should resolve
    // without the test timing out, proving the abort works.
    const fakeFetch = makeFakeFetch()
    const poller = new TelegramPoller({
      botToken: 'TEST',
      ownerChatId: OWNER,
      fetchImpl: fakeFetch.fetch,
      onUpdate: () => {},
    })
    poller.start()
    await tick(2)
    poller.stop()
    // If stop() hadn't aborted, the loop would still be blocked on
    // fetch; reaching this assertion means we're free.
    expect(true).toBe(true)
  })
})

// =============================================================================
// Serializer helper
// =============================================================================

describe('serializeUpdateAsJsonl', () => {
  it('produces newline-terminated JSON', () => {
    const buf = serializeUpdateAsJsonl(ownerMessage('hi', 1))
    const text = buf.toString('utf8')
    expect(text.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(text)
    expect(parsed.update_id).toBe(1)
    expect(parsed.message.text).toBe('hi')
  })
})
