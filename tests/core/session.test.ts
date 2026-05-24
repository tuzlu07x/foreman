import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ControlChannel } from '../../src/core/control-channel.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import {
  SessionManager,
  SessionNotFoundError,
} from '../../src/core/session.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'

describe('SessionManager', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let manager: SessionManager

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    manager = new SessionManager(db, { bus })
  })

  afterEach(() => {
    sqlite.close()
  })

  it('startSession returns a ulid and writes the row', () => {
    const id = manager.startSession(['hermes', 'claude-code'])
    expect(id).toMatch(/^[0-9A-Z]{26}$/)
    const info = manager.get(id)
    expect(info).toMatchObject({
      id,
      participants: ['hermes', 'claude-code'],
      status: 'active',
      messageCount: 0,
      tokenCount: 0,
      endedAt: null,
    })
  })

  it('records turns 1..5 as allowed, halts on the 6th attempt', () => {
    const halted = vi.fn()
    bus.on('session:halted', halted)
    const id = manager.startSession(['a', 'b'])
    for (let i = 1; i <= 5; i++) {
      const result = manager.recordTurn(id)
      expect(result.allowed).toBe(true)
      expect(result.info.messageCount).toBe(i)
    }
    const sixth = manager.recordTurn(id)
    expect(sixth.allowed).toBe(false)
    expect(sixth.reason).toBe('turn_limit')
    expect(halted).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: id,
        reason: 'turn_limit',
        turnCount: 5,
      }),
    )
    expect(manager.get(id)?.status).toBe('halted')
  })

  it('halts on token limit before turn limit when tokens explode', () => {
    const halted = vi.fn()
    bus.on('session:halted', halted)
    const id = manager.startSession(['a', 'b'])
    manager.recordTurn(id, 50_000)
    const result = manager.recordTurn(id, 60_000)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('token_limit')
    expect(halted).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'token_limit' }),
    )
  })

  it('respects custom turn / token limits', () => {
    const tight = new SessionManager(db, {
      bus,
      turnLimit: 2,
      tokenLimit: 100,
    })
    const id = tight.startSession(['a', 'b'])
    expect(tight.recordTurn(id, 50).allowed).toBe(true)
    expect(tight.recordTurn(id, 30).allowed).toBe(true)
    const third = tight.recordTurn(id, 0)
    expect(third.allowed).toBe(false)
    expect(third.reason).toBe('turn_limit')
  })

  it('manual halt() flips status, emits session:halted, blocks further turns', () => {
    const halted = vi.fn()
    bus.on('session:halted', halted)
    const id = manager.startSession(['a', 'b'])
    manager.recordTurn(id)
    manager.halt(id)
    expect(manager.isHalted(id)).toBe(true)
    expect(halted).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'manual' }),
    )
    const after = manager.recordTurn(id)
    expect(after.allowed).toBe(false)
  })

  it('halt() on already-halted session is a no-op (no double emit)', () => {
    const halted = vi.fn()
    bus.on('session:halted', halted)
    const id = manager.startSession(['a', 'b'])
    manager.halt(id)
    manager.halt(id)
    expect(halted).toHaveBeenCalledOnce()
  })

  it('complete() flips status to completed and sets endedAt', () => {
    const id = manager.startSession(['a', 'b'])
    manager.complete(id)
    const info = manager.get(id)
    expect(info?.status).toBe('completed')
    expect(info?.endedAt).toBeGreaterThan(0)
  })

  it('getActive() returns only active sessions', () => {
    const a = manager.startSession(['x', 'y'])
    const b = manager.startSession(['x', 'z'])
    manager.halt(a)
    const active = manager.getActive().map((s) => s.id)
    expect(active).toEqual([b])
  })

  it('recordTurn() on an unknown session throws SessionNotFoundError', () => {
    expect(() => manager.recordTurn('nope')).toThrow(SessionNotFoundError)
  })

  // ============================================================================
  // #523 — Lifecycle events: session:started + session:completed.
  //
  // The new bridge in this PR subscribes to these to push "▶️ openclaw
  // çalışmaya başladı" / "✓ done in 23s" to Telegram. Pinning the emission
  // shape here keeps the bridge tests focused on routing, not parsing.
  // ============================================================================

  it('startSession emits session:started with participants + trigger', () => {
    const started = vi.fn()
    bus.on('session:started', started)
    const id = manager.startSession(['openclaw', 'hermes'], {
      trigger: 'user_command:write',
      estimatedTurns: 8,
    })
    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: id,
        participants: ['openclaw', 'hermes'],
        trigger: 'user_command:write',
        estimatedTurns: 8,
      }),
    )
    const payload = started.mock.calls[0]![0]
    expect(payload.startedAt).toBeGreaterThan(0)
  })

  it('startSession without opts defaults trigger to "unknown"', () => {
    // Legacy callsites that haven't been updated yet must still produce a
    // coherent event payload — the notification template doesn't crash on
    // missing fields.
    const started = vi.fn()
    bus.on('session:started', started)
    manager.startSession(['a', 'b'])
    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'unknown' }),
    )
    expect(started.mock.calls[0]![0].estimatedTurns).toBeUndefined()
  })

  it('complete() emits session:completed with outcome=success + duration', () => {
    const completed = vi.fn()
    bus.on('session:completed', completed)
    const id = manager.startSession(['a', 'b'])
    manager.recordTurn(id, 150)
    manager.recordTurn(id, 250)
    manager.complete(id)
    expect(completed).toHaveBeenCalledOnce()
    const payload = completed.mock.calls[0]![0]
    expect(payload).toMatchObject({
      sessionId: id,
      outcome: 'success',
      turnCount: 2,
      tokenCount: 400,
      costUsd: 0, // placeholder until #530
    })
    expect(payload.durationMs).toBeGreaterThanOrEqual(0)
    expect(payload.completedAt).toBeGreaterThan(0)
  })

  it('complete() on already-completed/halted session is a no-op (no double emit)', () => {
    const completed = vi.fn()
    bus.on('session:completed', completed)
    const id = manager.startSession(['a', 'b'])
    manager.halt(id) // emits completed once (outcome: 'halted')
    manager.complete(id) // already halted → no-op, no second emit
    expect(completed).toHaveBeenCalledOnce()
  })

  it('halt(reason="manual") emits session:halted + session:completed (no resolution path)', () => {
    // Manual halts have no interactive resolution template; the standard
    // lifecycle push ("⚠ halted") fires immediately so the user sees the
    // session is over. Loop-detection halts hold the session open until
    // the user resolves — covered by the "interactive resolution" suite
    // below.
    const halted = vi.fn()
    const completed = vi.fn()
    bus.on('session:halted', halted)
    bus.on('session:completed', completed)
    const id = manager.startSession(['a', 'b'])
    manager.halt(id, 'manual')
    expect(halted).toHaveBeenCalledOnce()
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: id,
        outcome: 'halted',
        reason: 'manual',
      }),
    )
  })

  it('turn-limit auto-halt fires session:completed immediately (no interactive resume in v0.1.1)', () => {
    // turn/token-limit halts are non-interactive in v0.1.1 — issue
    // #527 explicitly scopes interactive resume to loop_detection.
    // Budget halts get the standard "⚠ halted" lifecycle push.
    const completed = vi.fn()
    bus.on('session:completed', completed)
    const id = manager.startSession(['a', 'b'])
    for (let i = 0; i < 5; i++) manager.recordTurn(id)
    manager.recordTurn(id) // 6th → halts via turn_limit
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'halted',
        reason: 'turn_limit',
      }),
    )
  })

  it('loop_detection halt holds the session open + emits session:resolution-needed (#527)', () => {
    // Interactive halt: session:completed is DEFERRED until the user
    // picks a resolution (or the deadline expires + the session
    // auto-abandons). Pinning this is the contract between the
    // SessionManager and the NotificationBridge resolution prompt.
    const halted = vi.fn()
    const completed = vi.fn()
    const resolutionNeeded = vi.fn()
    bus.on('session:halted', halted)
    bus.on('session:completed', completed)
    bus.on('session:resolution-needed', resolutionNeeded)
    const id = manager.startSession(['openclaw', 'hermes'])
    manager.halt(id, 'loop_detection')
    expect(halted).toHaveBeenCalledOnce()
    expect(resolutionNeeded).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: id,
        reason: 'loop_detection',
      }),
    )
    // No completion event — the session is paused waiting for input.
    expect(completed).not.toHaveBeenCalled()
    // The session row now carries resolution metadata.
    const info = manager.get(id)!
    expect(info.status).toBe('halted')
    expect(info.resolutionStatus).toBe('needed')
    expect(info.resolutionOptions?.length).toBeGreaterThanOrEqual(4)
    expect(info.resolutionDeadlineMs).toBeGreaterThan(Date.now())
  })

  // ============================================================================
  // #529 — Token-budget enforcement via runtime tokenLimitProvider.
  //
  // The static `tokenLimit` option keeps working for callers without a
  // policy engine wired. The provider wins when both are present so a
  // `policy.yaml` reload moves the cap mid-session without rebuilding the
  // manager.
  // ============================================================================

  it('tokenLimitProvider takes precedence over the static tokenLimit option (#529)', () => {
    const halted = vi.fn()
    bus.on('session:halted', halted)
    const m = new SessionManager(db, {
      bus,
      turnLimit: 999,
      tokenLimit: 1000,
      tokenLimitProvider: () => 200,
    })
    const id = m.startSession(['a', 'b'])
    m.recordTurn(id, 100)
    const result = m.recordTurn(id, 150) // cumulative 250 > 200
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('token_limit')
    expect(halted).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'token_limit' }),
    )
  })

  it('tokenLimitProvider is invoked per recordTurn so live config changes apply (#529)', () => {
    // First call returns 500; the second returns 50 — the same session
    // that was previously allowed at 200 tokens should now be over budget
    // on the very next turn without rebuilding the manager.
    let limit = 500
    const m = new SessionManager(db, {
      bus,
      turnLimit: 999,
      tokenLimitProvider: () => limit,
    })
    const id = m.startSession(['a', 'b'])
    expect(m.recordTurn(id, 200).allowed).toBe(true)
    limit = 50 // policy.yaml reload simulated
    expect(m.recordTurn(id, 1).allowed).toBe(false)
  })

  it('falls back to the static tokenLimit when the provider throws (#529)', () => {
    // Defensive: a misconfigured provider must not crash recordTurn — the
    // existing static limit is the safe fallback.
    const m = new SessionManager(db, {
      bus,
      turnLimit: 999,
      tokenLimit: 100,
      tokenLimitProvider: () => {
        throw new Error('boom')
      },
    })
    const id = m.startSession(['a', 'b'])
    expect(m.recordTurn(id, 50).allowed).toBe(true)
    expect(m.recordTurn(id, 60).allowed).toBe(false) // 110 > 100
  })

  it('falls back when the provider returns a non-positive value (#529)', () => {
    // Zero / negative / NaN limits would otherwise lock the session out on
    // turn 1. Treat them as "use the static fallback" instead.
    const m = new SessionManager(db, {
      bus,
      turnLimit: 999,
      tokenLimit: 100,
      tokenLimitProvider: () => 0,
    })
    const id = m.startSession(['a', 'b'])
    expect(m.recordTurn(id, 50).allowed).toBe(true)
  })

  // ============================================================================
  // #527 — Interactive session resume: provideResolution, expireResolution,
  // control-channel delivery, audit-clean lifecycle.
  // ============================================================================
  describe('interactive resume (#527)', () => {
    it('provideResolution(skip) resumes the session + broadcasts a write to every participant', () => {
      const channel = new ControlChannel(db)
      const m = new SessionManager(db, { bus, controlChannel: channel })
      const resumed = vi.fn()
      bus.on('session:resumed', resumed)
      const id = m.startSession(['openclaw', 'hermes'])
      m.halt(id, 'loop_detection')
      const option = m.provideResolution(id, 'opt-skip', {
        providedBy: 'tg-user-1',
      })
      expect(option?.id).toBe('opt-skip')
      // Session flipped back to active.
      const info = m.get(id)!
      expect(info.status).toBe('active')
      expect(info.resolutionStatus).toBe('consumed')
      expect(info.resolutionRecord?.optionId).toBe('opt-skip')
      expect(info.resolutionRecord?.providedBy).toBe('tg-user-1')
      // Bus event fired with the right payload.
      expect(resumed).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: id,
          optionId: 'opt-skip',
          payload: expect.objectContaining({ kind: 'skip' }),
          providedBy: 'tg-user-1',
        }),
      )
      // Control channel: one `write` row per participant.
      const pending = channel.pending()
      expect(pending).toHaveLength(2)
      const targets = pending.map((r) => JSON.parse(r.args)[0])
      expect(targets.sort()).toEqual(['hermes', 'openclaw'])
      for (const row of pending) {
        expect(row.command).toBe('write')
        const args = JSON.parse(row.args) as string[]
        expect(args[1]).toContain(`[session ${id}]`)
        expect(args[1]).toContain('skip')
      }
    })

    it('provideResolution(delegate-to) routes to a single target', () => {
      const channel = new ControlChannel(db)
      const m = new SessionManager(db, { bus, controlChannel: channel })
      const id = m.startSession(['openclaw', 'hermes'])
      m.halt(id, 'loop_detection')
      m.provideResolution(id, 'opt-delegate-pm')
      const pending = channel.pending()
      expect(pending).toHaveLength(1)
      const args = JSON.parse(pending[0]!.args) as string[]
      expect(args[0]).toBe('openclaw')
      expect(args[1]).toContain(`[session ${id}]`)
    })

    it('provideResolution(user-input-needed) prompts the first participant', () => {
      const channel = new ControlChannel(db)
      const m = new SessionManager(db, { bus, controlChannel: channel })
      const id = m.startSession(['hermes', 'openclaw'])
      m.halt(id, 'loop_detection')
      m.provideResolution(id, 'opt-user-decide')
      const pending = channel.pending()
      expect(pending).toHaveLength(1)
      const args = JSON.parse(pending[0]!.args) as string[]
      expect(args[0]).toBe('hermes') // first participant
      expect(args[1]).toContain('asked to decide manually')
    })

    it('provideResolution(abandon) finalizes as abandoned + does NOT enqueue any write', () => {
      const channel = new ControlChannel(db)
      const m = new SessionManager(db, { bus, controlChannel: channel })
      const completed = vi.fn()
      bus.on('session:completed', completed)
      const id = m.startSession(['openclaw', 'hermes'])
      m.halt(id, 'loop_detection')
      m.provideResolution(id, 'opt-abandon')
      expect(channel.pending()).toHaveLength(0)
      expect(completed).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: id,
          outcome: 'abandoned',
          reason: 'user-abandoned',
        }),
      )
      expect(m.get(id)?.status).toBe('completed')
    })

    it('provideResolution returns null for an unknown option id', () => {
      const m = new SessionManager(db, { bus })
      const id = m.startSession(['a', 'b'])
      m.halt(id, 'loop_detection')
      expect(m.provideResolution(id, 'nope')).toBeNull()
      // Session stays needing resolution.
      expect(m.get(id)?.resolutionStatus).toBe('needed')
    })

    it('provideResolution returns null when the session is not waiting for one', () => {
      const m = new SessionManager(db, { bus })
      const id = m.startSession(['a', 'b'])
      // Never halted → no resolution to provide.
      expect(m.provideResolution(id, 'opt-skip')).toBeNull()
    })

    it('expireResolution auto-abandons a needs-resolution session past its deadline', () => {
      const m = new SessionManager(db, { bus })
      const completed = vi.fn()
      bus.on('session:completed', completed)
      const id = m.startSession(['openclaw', 'hermes'])
      m.halt(id, 'loop_detection')
      const expired = m.expireResolution(id)
      expect(expired).toBe(true)
      expect(m.get(id)?.status).toBe('completed')
      expect(completed).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: id,
          outcome: 'abandoned',
          reason: 'resolution_timeout',
        }),
      )
    })

    it('expireResolution is a no-op when the session never needed one', () => {
      const m = new SessionManager(db, { bus })
      const id = m.startSession(['a', 'b'])
      expect(m.expireResolution(id)).toBe(false)
    })

    it('skipping the control channel still resumes state (degraded delivery)', () => {
      // Unit-test wiring with no ControlChannel — state flips, no
      // writes enqueued. Useful for tests that don't care about
      // delivery + as a pragmatic fallback if the channel is down.
      const m = new SessionManager(db, { bus })
      const id = m.startSession(['openclaw', 'hermes'])
      m.halt(id, 'loop_detection')
      const option = m.provideResolution(id, 'opt-skip')
      expect(option?.id).toBe('opt-skip')
      expect(m.get(id)?.status).toBe('active')
      expect(m.get(id)?.resolutionStatus).toBe('consumed')
    })

    it('resolution metadata round-trips through SessionInfo (audit-replay)', () => {
      const m = new SessionManager(db, { bus })
      const id = m.startSession(['openclaw', 'hermes'])
      m.halt(id, 'loop_detection')
      const info = m.get(id)!
      // Options offered land on the SessionInfo so `foreman log` /
      // future TUI views can render the prompt the user saw.
      const ids = (info.resolutionOptions ?? []).map((o) => o.id)
      expect(ids).toContain('opt-skip')
      expect(ids).toContain('opt-delegate-pm')
      expect(ids).toContain('opt-user-decide')
      expect(ids).toContain('opt-abandon')
    })
  })

  // ============================================================================
  // #530 — Per-session cost rollup + project tag plumbing.
  // ============================================================================
  describe('cost rollup + project tag (#530)', () => {
    it('costProvider is invoked on complete() + the result lands on session:completed', () => {
      const provider = vi.fn(() => 1.23)
      const m = new SessionManager(db, { bus, costProvider: provider })
      const completed = vi.fn()
      bus.on('session:completed', completed)
      const id = m.startSession(['hermes'])
      m.complete(id)
      expect(provider).toHaveBeenCalledWith(id)
      expect(completed).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: id,
          costUsd: 1.23,
        }),
      )
    })

    it('costProvider is invoked on the halted completion path too', () => {
      const provider = vi.fn(() => 0.42)
      const m = new SessionManager(db, { bus, costProvider: provider })
      const completed = vi.fn()
      bus.on('session:completed', completed)
      const id = m.startSession(['hermes'])
      m.halt(id, 'manual') // non-interactive → emits completed immediately
      expect(provider).toHaveBeenCalledWith(id)
      expect(completed).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: id,
          costUsd: 0.42,
          outcome: 'halted',
        }),
      )
    })

    it('falls back to costUsd=0 when no provider is wired', () => {
      const m = new SessionManager(db, { bus })
      const completed = vi.fn()
      bus.on('session:completed', completed)
      const id = m.startSession(['hermes'])
      m.complete(id)
      expect(completed).toHaveBeenCalledWith(
        expect.objectContaining({ costUsd: 0 }),
      )
    })

    it('falls back to 0 when the provider throws (defensive)', () => {
      const m = new SessionManager(db, {
        bus,
        costProvider: () => {
          throw new Error('boom')
        },
      })
      const completed = vi.fn()
      bus.on('session:completed', completed)
      const id = m.startSession(['hermes'])
      m.complete(id)
      expect(completed).toHaveBeenCalledWith(
        expect.objectContaining({ costUsd: 0 }),
      )
    })

    it('falls back to 0 when the provider returns a negative / NaN value', () => {
      const m = new SessionManager(db, {
        bus,
        costProvider: () => -1,
      })
      const completed = vi.fn()
      bus.on('session:completed', completed)
      const id = m.startSession(['hermes'])
      m.complete(id)
      expect(completed).toHaveBeenCalledWith(
        expect.objectContaining({ costUsd: 0 }),
      )
    })

    it('startSession with projectTag surfaces it on session:completed', () => {
      const m = new SessionManager(db, { bus })
      const completed = vi.fn()
      bus.on('session:completed', completed)
      const id = m.startSession(['hermes'], { projectTag: 'todo-app' })
      m.complete(id)
      expect(completed).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: id,
          projectTag: 'todo-app',
        }),
      )
    })

    it('omits projectTag from session:completed when startSession didn\'t set one', () => {
      const m = new SessionManager(db, { bus })
      const completed = vi.fn()
      bus.on('session:completed', completed)
      const id = m.startSession(['hermes'])
      m.complete(id)
      const payload = completed.mock.calls[0]![0] as { projectTag?: string }
      expect(payload.projectTag).toBeUndefined()
    })

    it('projectTag survives halted + abandoned terminal paths', () => {
      const m = new SessionManager(db, { bus })
      const completed = vi.fn()
      bus.on('session:completed', completed)

      // Halted (non-interactive: manual halt)
      const id1 = m.startSession(['hermes'], { projectTag: 'p1' })
      m.halt(id1, 'manual')
      expect(completed).toHaveBeenCalledWith(
        expect.objectContaining({ projectTag: 'p1', outcome: 'halted' }),
      )

      // Abandoned (loop_detection halt + expireResolution)
      const id2 = m.startSession(['hermes', 'openclaw'], { projectTag: 'p2' })
      m.halt(id2, 'loop_detection')
      m.expireResolution(id2)
      expect(completed).toHaveBeenCalledWith(
        expect.objectContaining({
          projectTag: 'p2',
          outcome: 'abandoned',
        }),
      )
    })
  })
})
