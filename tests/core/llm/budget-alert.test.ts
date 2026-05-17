import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  featureSplit,
  parseSince,
  queryUsage,
  recordUsage,
  recordUsageAndCheckBudget,
} from '../../../src/core/llm/budget.js'
import { defaultLlmConfig } from '../../../src/core/llm/config.js'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'
import {
  EventBus,
  type ForemanEventMap,
} from '../../../src/core/event-bus.js'
import { auditEvents } from '../../../src/db/schema.js'

describe('parseSince', () => {
  it('parses Nd / Nh / Nm into ms', () => {
    expect(parseSince('1d')).toBe(86_400_000)
    expect(parseSince('2h')).toBe(7_200_000)
    expect(parseSince('15m')).toBe(900_000)
  })

  it('rejects malformed input', () => {
    expect(() => parseSince('1week')).toThrow(/invalid --since/)
    expect(() => parseSince('-3h')).toThrow(/invalid --since/)
    expect(() => parseSince('')).toThrow(/invalid --since/)
  })
})

describe('queryUsage — filters', () => {
  let db: ForemanDb
  let sqlite: Database.Database

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    const now = Date.now()
    recordUsage(db, {
      ts: now - 3600_000,
      provider: 'anthropic',
      model: 'm',
      feature: 'verification',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
      durationMs: 10,
    })
    recordUsage(db, {
      ts: now - 60_000,
      provider: 'anthropic',
      model: 'm',
      feature: 'smart_report',
      inputTokens: 20,
      outputTokens: 10,
      costUsd: 0.002,
      durationMs: 20,
    })
    recordUsage(db, {
      ts: now - 5_000,
      provider: 'anthropic',
      model: 'm',
      feature: 'test',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      durationMs: 5,
    })
  })

  afterEach(() => { sqlite.close() })

  it('filters by --since (newer-than threshold)', () => {
    const rows = queryUsage(db, { since: Date.now() - 120_000 })
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.feature)).toEqual(['test', 'smart_report'])
  })

  it('filters by --feature', () => {
    const rows = queryUsage(db, { feature: 'verification' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.feature).toBe('verification')
  })

  it('combines --since + --feature', () => {
    const rows = queryUsage(db, {
      since: Date.now() - 86_400_000,
      feature: 'smart_report',
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.feature).toBe('smart_report')
  })

  it('honours limit', () => {
    expect(queryUsage(db, { limit: 1 }).length).toBe(1)
  })
})

describe('featureSplit', () => {
  let db: ForemanDb
  let sqlite: Database.Database

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
  })

  afterEach(() => { sqlite.close() })

  it('aggregates per feature, sorted by spend descending', () => {
    recordUsage(db, {
      provider: 'a',
      model: 'm',
      feature: 'verification',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0.01,
      durationMs: 1,
    })
    recordUsage(db, {
      provider: 'a',
      model: 'm',
      feature: 'verification',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0.02,
      durationMs: 1,
    })
    recordUsage(db, {
      provider: 'a',
      model: 'm',
      feature: 'smart_report',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0.05,
      durationMs: 1,
    })
    const split = featureSplit(db, defaultLlmConfig())
    expect(split[0]!.feature).toBe('smart_report')
    expect(split[0]!.spentUsd).toBeCloseTo(0.05, 4)
    expect(split[1]!.feature).toBe('verification')
    expect(split[1]!.spentUsd).toBeCloseTo(0.03, 4)
    expect(split[1]!.callCount).toBe(2)
  })

  it('returns empty list when no usage', () => {
    expect(featureSplit(db, defaultLlmConfig())).toEqual([])
  })
})

describe('recordUsageAndCheckBudget — alert thresholds', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let received: ForemanEventMap['llm:budget-alert'][]

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    received = []
    bus.on('llm:budget-alert', (e) => {
      received.push(e)
    })
  })

  afterEach(() => { sqlite.close() })

  it('fires threshold alert when crossing alert_threshold_pct', () => {
    const config = defaultLlmConfig()
    config.budget.monthly_cap_usd = 1
    config.budget.alert_threshold_pct = 80
    // Below threshold first call.
    recordUsageAndCheckBudget(
      db,
      config,
      {
        provider: 'a',
        model: 'm',
        feature: 'verification',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0.3,
        durationMs: 1,
      },
      bus,
    )
    expect(received).toHaveLength(0)
    // This second call pushes total to 0.85 → over 80% but under 100%.
    const res = recordUsageAndCheckBudget(
      db,
      config,
      {
        provider: 'a',
        model: 'm',
        feature: 'verification',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0.55,
        durationMs: 1,
      },
      bus,
    )
    expect(res.alertFired).toBe('threshold')
    expect(received).toHaveLength(1)
    expect(received[0]!.kind).toBe('threshold')
    expect(received[0]!.spentPct).toBeGreaterThanOrEqual(80)
  })

  it('only fires threshold alert ONCE per billing window', () => {
    const config = defaultLlmConfig()
    config.budget.monthly_cap_usd = 1
    config.budget.alert_threshold_pct = 50
    recordUsageAndCheckBudget(
      db,
      config,
      {
        provider: 'a',
        model: 'm',
        feature: 'verification',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0.6,
        durationMs: 1,
      },
      bus,
    )
    recordUsageAndCheckBudget(
      db,
      config,
      {
        provider: 'a',
        model: 'm',
        feature: 'verification',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0.1,
        durationMs: 1,
      },
      bus,
    )
    expect(received).toHaveLength(1)
  })

  it('fires exhausted alert when crossing 100% — separately from threshold', () => {
    const config = defaultLlmConfig()
    config.budget.monthly_cap_usd = 1
    config.budget.alert_threshold_pct = 80
    // First push over 80% (threshold)
    recordUsageAndCheckBudget(
      db,
      config,
      {
        provider: 'a',
        model: 'm',
        feature: 'verification',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0.9,
        durationMs: 1,
      },
      bus,
    )
    // Then over 100% (exhausted)
    recordUsageAndCheckBudget(
      db,
      config,
      {
        provider: 'a',
        model: 'm',
        feature: 'verification',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0.2,
        durationMs: 1,
      },
      bus,
    )
    expect(received.map((e) => e.kind)).toEqual(['threshold', 'exhausted'])
  })

  it('does not fire on cached calls (costUsd = 0)', () => {
    const config = defaultLlmConfig()
    config.budget.monthly_cap_usd = 0.01
    recordUsageAndCheckBudget(
      db,
      config,
      {
        provider: 'a',
        model: 'm',
        feature: 'verification',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        durationMs: 1,
        cacheHit: true,
      },
      bus,
    )
    expect(received).toHaveLength(0)
  })

  it('persists an llm_budget_alert audit row on fire', () => {
    const config = defaultLlmConfig()
    config.budget.monthly_cap_usd = 1
    config.budget.alert_threshold_pct = 80
    recordUsageAndCheckBudget(
      db,
      config,
      {
        provider: 'a',
        model: 'm',
        feature: 'verification',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0.95,
        durationMs: 1,
      },
      bus,
    )
    const rows = db.select().from(auditEvents).all()
    const alerts = rows.filter((r) => r.eventType === 'llm_budget_alert')
    expect(alerts).toHaveLength(1)
    const payload = JSON.parse(alerts[0]!.payload ?? '{}')
    expect(payload.kind).toBe('threshold')
    expect(payload.spentUsd).toBeCloseTo(0.95, 4)
  })
})
