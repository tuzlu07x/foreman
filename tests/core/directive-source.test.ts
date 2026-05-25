import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ControlChannel } from '../../src/core/control-channel.js'
import {
  DirectiveSource,
  parseWriteArgs,
} from '../../src/core/directive-source.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'

describe('parseWriteArgs', () => {
  it('parses a valid [agentId, body] tuple', () => {
    expect(parseWriteArgs(JSON.stringify(['hermes', 'do X']))).toEqual({
      agentId: 'hermes',
      body: 'do X',
    })
  })

  it('returns null on invalid JSON', () => {
    expect(parseWriteArgs('not-json')).toBeNull()
  })

  it('returns null when the array shape is wrong', () => {
    expect(parseWriteArgs(JSON.stringify({}))).toBeNull()
    expect(parseWriteArgs(JSON.stringify(['only-one']))).toBeNull()
    expect(parseWriteArgs(JSON.stringify([42, 'body']))).toBeNull()
    expect(parseWriteArgs(JSON.stringify(['', 'body']))).toBeNull()
  })
})

describe('DirectiveSource', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let channel: ControlChannel

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    channel = new ControlChannel(db)
  })

  afterEach(() => {
    sqlite.close()
  })

  function enqueueWrite(agentId: string, body: string): number {
    return channel.enqueue({
      command: 'write',
      args: [agentId, body],
      sourceAgent: 'cli',
    }).id
  }

  it('drains pending write rows for its agent and marks them applied', async () => {
    const id = enqueueWrite('hermes', 'directive A')
    const received: string[] = []
    const source = new DirectiveSource({
      channel,
      agentId: 'hermes',
      pollIntervalMs: 60_000, // never fire — drive via drainOnce()
      onDirective: async ({ body }) => {
        received.push(body)
        return { ok: true }
      },
    })
    source.start()
    await source.drainOnce()
    source.stop()

    expect(received).toEqual(['directive A'])
    const row = channel.get(id)
    expect(row?.status).toBe('applied')
  })

  it('ignores write rows targeted at a different agent', async () => {
    const otherId = enqueueWrite('openclaw', 'not for hermes')
    const ownId = enqueueWrite('hermes', 'for hermes')
    const received: string[] = []
    const source = new DirectiveSource({
      channel,
      agentId: 'hermes',
      pollIntervalMs: 60_000,
      onDirective: async ({ body }) => {
        received.push(body)
        return { ok: true }
      },
    })
    source.start()
    await source.drainOnce()
    source.stop()

    expect(received).toEqual(['for hermes'])
    expect(channel.get(otherId)?.status).toBe('pending')
    expect(channel.get(ownId)?.status).toBe('applied')
  })

  it('ignores rows whose command is not `write`', async () => {
    const stopId = channel.enqueue({
      command: 'stop',
      args: [],
      sourceAgent: 'cli',
    }).id
    const received: string[] = []
    const source = new DirectiveSource({
      channel,
      agentId: 'hermes',
      pollIntervalMs: 60_000,
      onDirective: async ({ body }) => {
        received.push(body)
        return { ok: true }
      },
    })
    source.start()
    await source.drainOnce()
    source.stop()

    expect(received).toEqual([])
    // stop row stays pending — the wrap doesn't claim it.
    expect(channel.get(stopId)?.status).toBe('pending')
  })

  it('marks a row failed when onDirective returns ok:false', async () => {
    const id = enqueueWrite('hermes', 'will fail')
    const errors: Error[] = []
    const source = new DirectiveSource({
      channel,
      agentId: 'hermes',
      pollIntervalMs: 60_000,
      onDirective: async () => ({ ok: false as const, error: 'child stdin closed' }),
      onError(err) {
        errors.push(err)
      },
    })
    source.start()
    await source.drainOnce()
    source.stop()

    const row = channel.get(id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain('child stdin closed')
    expect(errors).toHaveLength(1)
  })

  it('catches handler throws and marks the row failed (does not crash the loop)', async () => {
    enqueueWrite('hermes', 'will throw')
    const id2 = enqueueWrite('hermes', 'should still run')
    const received: string[] = []
    const source = new DirectiveSource({
      channel,
      agentId: 'hermes',
      pollIntervalMs: 60_000,
      onDirective: async ({ body }) => {
        if (body === 'will throw') throw new Error('handler bomb')
        received.push(body)
        return { ok: true }
      },
    })
    source.start()
    await source.drainOnce()
    source.stop()

    expect(received).toEqual(['should still run'])
    expect(channel.get(id2)?.status).toBe('applied')
  })

  it('processes rows in FIFO order (createdAt)', async () => {
    enqueueWrite('hermes', 'first')
    enqueueWrite('hermes', 'second')
    enqueueWrite('hermes', 'third')
    const received: string[] = []
    const source = new DirectiveSource({
      channel,
      agentId: 'hermes',
      pollIntervalMs: 60_000,
      onDirective: async ({ body }) => {
        received.push(body)
        return { ok: true }
      },
    })
    source.start()
    await source.drainOnce()
    source.stop()

    expect(received).toEqual(['first', 'second', 'third'])
  })

  it('start() / stop() are idempotent', () => {
    const setIntervalSpy = vi.fn(() => 'fake-handle' as unknown as ReturnType<typeof setInterval>)
    const clearIntervalSpy = vi.fn()
    const source = new DirectiveSource({
      channel,
      agentId: 'hermes',
      onDirective: async () => ({ ok: true }),
      setIntervalImpl: setIntervalSpy as unknown as (
        cb: () => void,
        ms: number,
      ) => unknown,
      clearIntervalImpl: clearIntervalSpy,
    })
    source.start()
    source.start() // no-op
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    source.stop()
    source.stop() // no-op
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
  })

  it('drainOnce works without start() — useful for tests + one-off drains', async () => {
    enqueueWrite('hermes', 'manual drain')
    const received: string[] = []
    const source = new DirectiveSource({
      channel,
      agentId: 'hermes',
      pollIntervalMs: 60_000,
      onDirective: async ({ body }) => {
        received.push(body)
        return { ok: true }
      },
    })
    // No start() — drainOnce drains regardless of running state, so
    // a test can drive it deterministically without spinning a timer.
    await source.drainOnce()
    expect(received).toEqual(['manual drain'])
  })

  it('re-entrant drainOnce calls await the in-flight drain (no race)', async () => {
    enqueueWrite('hermes', 'one')
    enqueueWrite('hermes', 'two')
    let inFlight = 0
    let maxConcurrent = 0
    const source = new DirectiveSource({
      channel,
      agentId: 'hermes',
      pollIntervalMs: 60_000,
      async onDirective() {
        inFlight += 1
        maxConcurrent = Math.max(maxConcurrent, inFlight)
        await new Promise((r) => setImmediate(r))
        inFlight -= 1
        return { ok: true }
      },
    })
    // Two simultaneous drainOnce calls: the second must await the
    // first instead of starting a parallel drain.
    await Promise.all([source.drainOnce(), source.drainOnce()])
    expect(maxConcurrent).toBe(1)
  })
})
