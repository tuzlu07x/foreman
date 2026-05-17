import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateSummary } from '../../../src/core/notification/summary-generator.js'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'
import { notifications, requests } from '../../../src/db/schema.js'

function seedRequest(
  db: ForemanDb,
  overrides: Partial<typeof requests.$inferInsert>,
): void {
  db.insert(requests)
    .values({
      id: overrides.id ?? `r-${Math.random().toString(36).slice(2)}`,
      sourceAgent: overrides.sourceAgent ?? 'hermes',
      targetAgent: overrides.targetAgent ?? 'claude-code',
      targetTool: overrides.targetTool ?? 'echo',
      args: overrides.args ?? '{}',
      riskScore: overrides.riskScore ?? 10,
      riskBucket: overrides.riskBucket ?? 'low',
      decision: overrides.decision ?? 'allowed',
      createdAt: overrides.createdAt ?? Date.now(),
    })
    .run()
}

function seedNotification(
  db: ForemanDb,
  level: 'critical' | 'warning' | 'info' | 'summary' = 'critical',
): void {
  db.insert(notifications)
    .values({
      id: `n-${Math.random().toString(36).slice(2)}`,
      level,
      channel: 'telegram',
      body: 'body',
      status: 'sent',
      sentAt: Date.now(),
    })
    .run()
}

describe('generateSummary', () => {
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

  it('produces a "no news is good news" body on empty audit', () => {
    const n = generateSummary(db)
    expect(n.level).toBe('summary')
    expect(n.title).toContain('summary')
    expect(n.body).toContain('No tool calls')
    expect(n.body).toContain('quiet')
  })

  it('counts total calls + allowed + denied', () => {
    seedRequest(db, { sourceAgent: 'hermes', decision: 'allowed' })
    seedRequest(db, { sourceAgent: 'hermes', decision: 'allowed' })
    seedRequest(db, { sourceAgent: 'openclaw', decision: 'denied' })
    const n = generateSummary(db)
    expect(n.body).toContain('3 tool calls')
    expect(n.body).toContain('2 allowed, 1 denied')
  })

  it('flags high-risk calls when riskBucket is high or critical', () => {
    seedRequest(db, { riskBucket: 'high' })
    seedRequest(db, { riskBucket: 'critical' })
    seedRequest(db, { riskBucket: 'low' })
    const n = generateSummary(db)
    expect(n.body).toContain('2 high-risk')
  })

  it('lists active agents sorted', () => {
    seedRequest(db, { sourceAgent: 'openclaw' })
    seedRequest(db, { sourceAgent: 'hermes' })
    const n = generateSummary(db)
    const lines = n.body.split('\n')
    const hermesIdx = lines.findIndex((l) => l.includes('hermes'))
    const claweIdx = lines.findIndex((l) => l.includes('openclaw'))
    expect(hermesIdx).toBeGreaterThan(0)
    expect(claweIdx).toBeGreaterThan(hermesIdx) // sorted alpha
  })

  it('skips calls outside the configured window', () => {
    seedRequest(db, { createdAt: Date.now() - 24 * 3_600_000 }) // 24h ago
    const n = generateSummary(db, { windowMs: 6 * 3_600_000 }) // 6h window
    expect(n.body).toContain('No tool calls')
  })

  it('includes notification count in the body when > 0', () => {
    seedRequest(db, {})
    seedNotification(db, 'critical')
    seedNotification(db, 'warning')
    // A prior summary should NOT be counted toward "notifications delivered"
    seedNotification(db, 'summary')
    const n = generateSummary(db)
    expect(n.body).toContain('2 notifications delivered')
  })

  it('mentions enabling LLM analysis as a footer', () => {
    seedRequest(db, {})
    const n = generateSummary(db)
    expect(n.body).toContain('foreman llm enable')
  })

  it('formats the window humanely in the title', () => {
    seedRequest(db, {})
    const a = generateSummary(db, { windowMs: 12 * 3_600_000 })
    expect(a.title).toContain('12 hours')
    const b = generateSummary(db, { windowMs: 7 * 86_400_000 })
    expect(b.title).toContain('7 days')
    const c = generateSummary(db, { windowMs: 30 * 60_000 })
    expect(c.title).toContain('30 minutes')
  })

  it('singularises "1 agent" / "1 high-risk call" / "1 notification"', () => {
    seedRequest(db, { sourceAgent: 'hermes', riskBucket: 'high' })
    seedNotification(db, 'critical')
    const n = generateSummary(db)
    expect(n.body).toContain('1 tool calls across 1 agent')
    expect(n.body).toContain('1 high-risk call flagged')
    expect(n.body).toContain('1 notification delivered')
  })
})
