import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import type Database from 'better-sqlite3'
import { requests } from '../../src/db/schema.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { ForemanVoice } from '../../src/core/notification/foreman-voice.js'
import { PatternDetectionService } from '../../src/core/pattern-detection-service.js'
import type {
  NotificationLevel,
  Notification,
} from '../../src/core/notification/types.js'

// =============================================================================
// Tests for #304 — PatternDetectionService dispatch
// =============================================================================
//
// End-to-end: seed audit rows → service.tick() → fake NotificationService
// receives the right number / shape of proactive messages.

interface SendCall {
  level: NotificationLevel
  payload: Omit<Notification, 'id'>
}

function fakeService(): {
  service: {
    send: (
      level: NotificationLevel,
      payload: Omit<Notification, 'id'>,
    ) => Promise<{ notificationId: string; outcomes: Map<string, unknown> }>
  }
  calls: SendCall[]
} {
  const calls: SendCall[] = []
  let counter = 0
  return {
    calls,
    service: {
      send: async (level, payload) => {
        calls.push({ level, payload })
        counter += 1
        return { notificationId: `notif-${counter}`, outcomes: new Map() }
      },
    },
  }
}

const NOW = 1_730_000_000_000

function seedDenials(
  db: ForemanDb,
  count: number,
  base: Partial<typeof requests.$inferInsert> = {},
): void {
  for (let i = 0; i < count; i++) {
    db.insert(requests)
      .values({
        id: `r-d-${i}-${Math.random().toString(36).slice(2, 6)}`,
        sourceAgent: 'hermes',
        targetTool: 'read_file',
        args: '{}',
        riskScore: 0,
        decision: 'denied',
        decidedBy: 'user',
        createdAt: NOW - i * 1000,
        ...base,
      })
      .run()
  }
}

describe('PatternDetectionService', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let voice: ForemanVoice
  let fake: ReturnType<typeof fakeService>

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    fake = fakeService()
    voice = new ForemanVoice({
      service: fake.service as never,
      bus,
      // disable throttle for these tests so each tick can dispatch
      throttleMs: {
        pattern_detection: 0,
      },
    })
  })

  afterEach(() => {
    sqlite.close()
  })

  it('tick() with no patterns sends nothing', async () => {
    const svc = new PatternDetectionService({
      db,
      voice,
      now: () => NOW,
    })
    const patterns = await svc.tick()
    expect(patterns).toEqual([])
    expect(fake.calls).toHaveLength(0)
  })

  it('tick() dispatches a proactive message for each detected pattern', async () => {
    seedDenials(db, 3)
    const svc = new PatternDetectionService({
      db,
      voice,
      now: () => NOW,
    })
    const patterns = await svc.tick()
    expect(patterns.some((p) => p.kind === 'repeated_denial')).toBe(true)
    expect(fake.calls.length).toBeGreaterThan(0)
    expect(fake.calls[0]!.level).toBe('warning')
    expect(fake.calls[0]!.payload.title).toMatch(/Repeated denial/)
    expect(fake.calls[0]!.payload.body).toContain('foreman policy add')
  })

  it('respects detector thresholds passed through', async () => {
    seedDenials(db, 2)
    const svc = new PatternDetectionService({
      db,
      voice,
      now: () => NOW,
      thresholds: {
        repeatedDenialMin: 2,
        repeatedAllowMin: 5,
        burstMin: 10,
        burstWindowMs: 60_000,
        repeatedWindowMs: 60 * 60 * 1000,
        offResponsibilityMin: 3,
      },
    })
    const patterns = await svc.tick()
    expect(patterns).toHaveLength(1)
    expect(fake.calls).toHaveLength(1)
  })

  it('start() + stop() do not throw and the timer is unref-safe', () => {
    const svc = new PatternDetectionService({
      db,
      voice,
      tickMs: 60_000,
    })
    svc.start()
    svc.start() // idempotent
    svc.stop()
    svc.stop() // idempotent
  })

  it('only loads rows from the lookback window (older rows ignored)', async () => {
    seedDenials(db, 3, { createdAt: NOW - 2 * 60 * 60 * 1000 }) // 2h old → outside
    const svc = new PatternDetectionService({ db, voice, now: () => NOW })
    const patterns = await svc.tick()
    expect(patterns).toEqual([])
  })
})
