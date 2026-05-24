import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('halt() emits session:completed with outcome=halted + reason alongside session:halted', () => {
    const halted = vi.fn()
    const completed = vi.fn()
    bus.on('session:halted', halted)
    bus.on('session:completed', completed)
    const id = manager.startSession(['a', 'b'])
    manager.halt(id, 'loop_detection')
    expect(halted).toHaveBeenCalledOnce()
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: id,
        outcome: 'halted',
        reason: 'loop_detection',
      }),
    )
  })

  it('turn-limit auto-halt also fires session:completed (outcome=halted)', () => {
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
})
