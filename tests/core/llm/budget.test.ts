import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertBudget,
  currentWindow,
  getBudgetStatus,
  recentUsage,
  recordUsage,
} from '../../../src/core/llm/budget.js'
import { LlmBudgetExceededError } from '../../../src/core/llm/client.js'
import { defaultLlmConfig } from '../../../src/core/llm/config.js'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'

describe('llm-budget — recordUsage + recentUsage', () => {
  let db: ForemanDb
  let sqlite: Database.Database

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
  })

  afterEach(() => {
    sqlite.close()
  })

  it('persists a usage row that round-trips into recentUsage', () => {
    const id = recordUsage(db, {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      feature: 'test',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
      durationMs: 120,
    })
    expect(id).toMatch(/^[0-9A-Z]{26}$/) // ULID
    const rows = recentUsage(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(id)
    expect(rows[0]!.feature).toBe('test')
    expect(rows[0]!.costUsd).toBe(0.001)
    expect(rows[0]!.cacheHit).toBe(0)
  })

  it('cacheHit flag persists as integer 0/1', () => {
    recordUsage(db, {
      provider: 'anthropic',
      model: 'm',
      feature: 'verification',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: 5,
      cacheHit: true,
    })
    expect(recentUsage(db)[0]!.cacheHit).toBe(1)
  })

  it('recentUsage returns newest-first, capped at limit', () => {
    for (let i = 0; i < 5; i++) {
      recordUsage(db, {
        ts: 1_000_000 + i,
        provider: 'anthropic',
        model: 'm',
        feature: 'test',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        durationMs: 0,
      })
    }
    const rows = recentUsage(db, 3)
    expect(rows).toHaveLength(3)
    expect(rows[0]!.ts).toBeGreaterThan(rows[2]!.ts)
  })
})

describe('llm-budget — getBudgetStatus', () => {
  let db: ForemanDb
  let sqlite: Database.Database

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
  })

  afterEach(() => {
    sqlite.close()
  })

  it('returns zero spent on a fresh DB', () => {
    const status = getBudgetStatus(db, defaultLlmConfig())
    expect(status.spentUsd).toBe(0)
    expect(status.capUsd).toBe(5)
    expect(status.remainingUsd).toBe(5)
    expect(status.spentPct).toBe(0)
    expect(status.alertTripped).toBe(false)
  })

  it('sums cost over the current window only', () => {
    const config = defaultLlmConfig()
    const now = new Date(2026, 5, 15, 12, 0, 0).getTime() // June 15 noon
    const { windowStart } = currentWindow(config, now)
    // In-window cost: counted
    recordUsage(db, {
      ts: windowStart + 10_000,
      provider: 'anthropic',
      model: 'm',
      feature: 'verification',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0.5,
      durationMs: 1,
    })
    // Pre-window cost: excluded
    recordUsage(db, {
      ts: windowStart - 86_400_000,
      provider: 'anthropic',
      model: 'm',
      feature: 'verification',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0.5,
      durationMs: 1,
    })
    const status = getBudgetStatus(db, config, now)
    expect(status.spentUsd).toBe(0.5)
  })

  it('alertTripped fires at or above the threshold', () => {
    const config = defaultLlmConfig() // alert at 80%, cap $5
    recordUsage(db, {
      provider: 'anthropic',
      model: 'm',
      feature: 'verification',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 4.0, // 80%
      durationMs: 1,
    })
    expect(getBudgetStatus(db, config).alertTripped).toBe(true)
  })

  it('clamps spentPct to 100 when over cap', () => {
    const config = defaultLlmConfig()
    recordUsage(db, {
      provider: 'anthropic',
      model: 'm',
      feature: 'verification',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 100,
      durationMs: 1,
    })
    expect(getBudgetStatus(db, config).spentPct).toBe(100)
  })
})

describe('llm-budget — assertBudget', () => {
  let db: ForemanDb
  let sqlite: Database.Database

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
  })

  afterEach(() => {
    sqlite.close()
  })

  it('passes when under cap', () => {
    expect(() => assertBudget(db, defaultLlmConfig())).not.toThrow()
  })

  it('throws LlmBudgetExceededError at cap', () => {
    recordUsage(db, {
      provider: 'anthropic',
      model: 'm',
      feature: 'verification',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 5.5,
      durationMs: 1,
    })
    expect(() => assertBudget(db, defaultLlmConfig())).toThrow(
      LlmBudgetExceededError,
    )
  })
})

describe('llm-budget — currentWindow math', () => {
  it('returns this-month boundaries when today >= reset_day', () => {
    const config = defaultLlmConfig() // reset 1st
    // June 15
    const now = new Date(2026, 5, 15, 12, 0, 0).getTime()
    const { windowStart, windowEnd } = currentWindow(config, now)
    expect(new Date(windowStart).getMonth()).toBe(5) // June
    expect(new Date(windowStart).getDate()).toBe(1)
    expect(new Date(windowEnd).getMonth()).toBe(6) // July
  })

  it('returns last-month boundary when today < reset_day', () => {
    const config = defaultLlmConfig()
    config.budget.reset_day_of_month = 15
    // June 10 — before this month's reset → window started May 15
    const now = new Date(2026, 5, 10, 12, 0, 0).getTime()
    const { windowStart, windowEnd } = currentWindow(config, now)
    expect(new Date(windowStart).getMonth()).toBe(4) // May
    expect(new Date(windowStart).getDate()).toBe(15)
    expect(new Date(windowEnd).getMonth()).toBe(5) // June
    expect(new Date(windowEnd).getDate()).toBe(15)
  })

  it('wraps year boundary correctly (Jan 5 with reset 15 → window starts Dec 15)', () => {
    const config = defaultLlmConfig()
    config.budget.reset_day_of_month = 15
    const now = new Date(2026, 0, 5, 12, 0, 0).getTime()
    const { windowStart } = currentWindow(config, now)
    expect(new Date(windowStart).getFullYear()).toBe(2025)
    expect(new Date(windowStart).getMonth()).toBe(11) // December
  })
})
