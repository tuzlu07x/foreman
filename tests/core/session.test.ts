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
})
