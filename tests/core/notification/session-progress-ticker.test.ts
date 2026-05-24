import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EventBus,
  type ForemanEventMap,
} from '../../../src/core/event-bus.js'
import { SessionProgressTicker } from '../../../src/core/notification/session-progress-ticker.js'
import { SessionManager } from '../../../src/core/session.js'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'

// =============================================================================
// SessionProgressTicker (#523)
//
// All tests inject `nowFn` so the 15-min cadence is exercised without
// waiting real wall clock. Timer is also faked — tests call `.scan()`
// directly to keep the assertions explicit (when did the emit fire,
// not when did the test happen to wake up).
// =============================================================================

const ONE_MINUTE = 60 * 1000

describe('SessionProgressTicker', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let sessions: SessionManager
  // Controllable clock — tests advance via `now += ONE_MINUTE * N`.
  let now: number

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    sessions = new SessionManager(db, { bus })
    // Sync the fake clock with real wall time so SessionManager.startSession
    // (which uses Date.now() directly) matches the ticker's nowFn baseline.
    // Each test then advances `now` manually — deterministic from here on.
    now = Date.now()
  })

  afterEach(() => {
    sqlite.close()
  })

  function makeTicker(
    opts: Partial<{
      scanIntervalMs: number
      progressIntervalMs: number
    }> = {},
  ): SessionProgressTicker {
    return new SessionProgressTicker(sessions, {
      bus,
      nowFn: () => now,
      scanIntervalMs: opts.scanIntervalMs ?? 60_000,
      progressIntervalMs: opts.progressIntervalMs ?? 15 * ONE_MINUTE,
    })
  }

  it('does NOT emit on the very first scan — first progress fires after progressIntervalMs', () => {
    const progress = vi.fn()
    bus.on('session:progress', progress)
    const ticker = makeTicker()
    sessions.startSession(['hermes'], { trigger: 't' })
    ticker.scan()
    // A session that started "just now" hasn't accumulated 15 min of
    // wall clock yet — no progress ping. This keeps short sessions
    // (<15 min) from getting a noisy mid-progress ping between their
    // started + completed events.
    expect(progress).not.toHaveBeenCalled()
  })

  it('emits session:progress once the progress interval has elapsed', () => {
    const progress = vi.fn()
    bus.on('session:progress', progress)
    const ticker = makeTicker({ progressIntervalMs: 15 * ONE_MINUTE })
    const id = sessions.startSession(['openclaw'], { trigger: 't' })
    sessions.recordTurn(id, 1234)
    sessions.recordTurn(id, 2000)
    now += 15 * ONE_MINUTE + 1
    ticker.scan()
    expect(progress).toHaveBeenCalledOnce()
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: id,
        turnCount: 2,
        tokenCount: 3234,
      }),
    )
    const payload = progress.mock.calls[0]![0]
    expect(payload.elapsedMs).toBe(15 * ONE_MINUTE + 1)
    expect(payload.emittedAt).toBe(now)
  })

  it('emits at most once per progress interval per session', () => {
    const progress = vi.fn()
    bus.on('session:progress', progress)
    const ticker = makeTicker({ progressIntervalMs: 15 * ONE_MINUTE })
    sessions.startSession(['a'], { trigger: 't' })
    now += 15 * ONE_MINUTE + 1
    ticker.scan()
    expect(progress).toHaveBeenCalledOnce()
    // Second scan within the interval window — should NOT fire again.
    now += 60_000 // +1 min
    ticker.scan()
    expect(progress).toHaveBeenCalledOnce()
  })

  it('emits a second progress after another full interval elapses', () => {
    const progress = vi.fn()
    bus.on('session:progress', progress)
    const ticker = makeTicker({ progressIntervalMs: 15 * ONE_MINUTE })
    sessions.startSession(['a'], { trigger: 't' })
    now += 15 * ONE_MINUTE + 1
    ticker.scan()
    now += 15 * ONE_MINUTE + 1
    ticker.scan()
    expect(progress).toHaveBeenCalledTimes(2)
  })

  it('skips halted / completed sessions on subsequent scans', () => {
    const progress = vi.fn()
    bus.on('session:progress', progress)
    const ticker = makeTicker({ progressIntervalMs: 15 * ONE_MINUTE })
    const id = sessions.startSession(['a'], { trigger: 't' })
    now += 15 * ONE_MINUTE + 1
    sessions.complete(id) // status flips → no longer in getActive()
    ticker.scan()
    expect(progress).not.toHaveBeenCalled()
  })

  it('captures recentDecisions newest-first, capped at 3', () => {
    const progress = vi.fn()
    bus.on('session:progress', progress)
    const ticker = makeTicker({ progressIntervalMs: 15 * ONE_MINUTE })
    ticker.start()
    const id = sessions.startSession(['hermes'], { trigger: 't' })
    // Emit 5 decided events for the session — buffer should keep only the
    // 3 newest, newest first. Anything older gets dropped so the push body
    // stays compact regardless of how chatty the session is.
    const makeDecided = (
      tool: string,
    ): ForemanEventMap['request:decided'] => ({
      requestId: `req-${tool}`,
      sourceAgent: 'hermes',
      targetAgent: 'claude-code',
      targetTool: tool,
      args: {},
      decision: 'allowed',
      decidedBy: 'policy:allow',
      riskScore: 10,
      riskReasons: [],
      riskFactors: [],
      riskBucket: 'low',
      llmVerification: null,
      securityReport: null,
      durationMs: 1,
      createdAt: now,
      decidedAt: now,
      sessionId: id,
    })
    for (const tool of ['read_file', 'edit', 'bash', 'grep', 'write']) {
      bus.emit('request:decided', makeDecided(tool))
    }
    now += 15 * ONE_MINUTE + 1
    ticker.scan()
    const recent = progress.mock.calls[0]![0].recentDecisions
    expect(recent.map((r: { targetTool: string }) => r.targetTool)).toEqual([
      'write',
      'grep',
      'bash',
    ])
    ticker.stop()
  })

  it('ignores request:decided events without a sessionId', () => {
    const progress = vi.fn()
    bus.on('session:progress', progress)
    const ticker = makeTicker({ progressIntervalMs: 15 * ONE_MINUTE })
    ticker.start()
    const id = sessions.startSession(['a'], { trigger: 't' })
    // Untagged decision — should NOT pollute the session's ring buffer.
    bus.emit('request:decided', {
      requestId: 'orphan',
      sourceAgent: 'foo',
      args: {},
      decision: 'allowed',
      decidedBy: 'policy',
      riskScore: 0,
      riskReasons: [],
      riskFactors: [],
      riskBucket: 'low',
      llmVerification: null,
      securityReport: null,
      durationMs: 1,
      createdAt: now,
      decidedAt: now,
    })
    now += 15 * ONE_MINUTE + 1
    ticker.scan()
    expect(progress.mock.calls[0]![0].sessionId).toBe(id)
    expect(progress.mock.calls[0]![0].recentDecisions).toEqual([])
    ticker.stop()
  })

  it('drops the ring buffer when the session completes (no memory leak)', () => {
    const ticker = makeTicker({ progressIntervalMs: 15 * ONE_MINUTE })
    ticker.start()
    const id = sessions.startSession(['a'], { trigger: 't' })
    bus.emit('request:decided', {
      requestId: 'req-1',
      sourceAgent: 'a',
      targetTool: 'read_file',
      args: {},
      decision: 'allowed',
      decidedBy: 'policy',
      riskScore: 0,
      riskReasons: [],
      riskFactors: [],
      riskBucket: 'low',
      llmVerification: null,
      securityReport: null,
      durationMs: 1,
      createdAt: now,
      decidedAt: now,
      sessionId: id,
    })
    sessions.complete(id) // emits session:completed → ticker clears buffer
    // Re-start a same-id-prefix session would be impossible (ULID), but
    // simulate the buffer-drop by checking we can re-emit + scan with a
    // fresh new session having no decisions queued.
    const id2 = sessions.startSession(['b'], { trigger: 't' })
    now += 15 * ONE_MINUTE + 1
    const progress = vi.fn()
    bus.on('session:progress', progress)
    ticker.scan()
    expect(progress.mock.calls[0]![0].sessionId).toBe(id2)
    expect(progress.mock.calls[0]![0].recentDecisions).toEqual([])
    ticker.stop()
  })

  it('start() registers timer + bus listeners; stop() unregisters cleanly', () => {
    const ticker = makeTicker()
    expect(bus.listenerCount('request:decided')).toBe(0)
    expect(bus.listenerCount('session:completed')).toBe(0)
    ticker.start()
    expect(bus.listenerCount('request:decided')).toBe(1)
    expect(bus.listenerCount('session:completed')).toBe(1)
    ticker.stop()
    expect(bus.listenerCount('request:decided')).toBe(0)
    expect(bus.listenerCount('session:completed')).toBe(0)
  })

  it('start() is idempotent — second call does not duplicate listeners', () => {
    const ticker = makeTicker()
    ticker.start()
    ticker.start()
    expect(bus.listenerCount('request:decided')).toBe(1)
    expect(bus.listenerCount('session:completed')).toBe(1)
    ticker.stop()
  })
})
