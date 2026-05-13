import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuditLogger } from '../../src/core/audit.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { auditEvents, requests } from '../../src/db/schema.js'

function emitDecided(
  bus: EventBus<ForemanEventMap>,
  requestId: string,
  overrides: Partial<ForemanEventMap['request:decided']> = {},
): void {
  const now = Date.now()
  bus.emit('request:decided', {
    requestId,
    sourceAgent: 'hermes',
    targetAgent: 'claude-code',
    targetTool: 'read_file',
    args: { path: `src/${requestId}.ts` },
    decision: 'allowed',
    decidedBy: 'policy:7',
    riskScore: 10,
    riskReasons: [],
    durationMs: 5,
    createdAt: now - 5,
    decidedAt: now,
    ...overrides,
  })
}

describe('AuditLogger', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let audit: AuditLogger

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    audit = new AuditLogger(db, bus)
  })

  afterEach(() => {
    audit.dispose()
    sqlite.close()
  })

  it('persists a request:decided event with all columns populated', () => {
    emitDecided(bus, 'r1', {
      args: { path: '.env' },
      decision: 'denied',
      decidedBy: 'user',
      riskScore: 80,
      riskReasons: ['secret_file_pattern', 'agent_to_agent'],
      result: undefined,
    })
    audit.flush()
    const rows = db.select().from(requests).all()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.id).toBe('r1')
    expect(row.decision).toBe('denied')
    expect(row.decidedBy).toBe('user')
    expect(JSON.parse(row.args)).toEqual({ path: '.env' })
    expect(JSON.parse(row.riskReasons!)).toEqual([
      'secret_file_pattern',
      'agent_to_agent',
    ])
    expect(row.result).toBeNull()
  })

  it('flushes a burst of 200 events with no row loss', () => {
    for (let i = 0; i < 200; i++) emitDecided(bus, `r${i}`)
    audit.flush()
    const count = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM requests`)
      .get() as { n: number }
    expect(count.n).toBe(200)
  })

  it('keeps requests_fts in sync — FTS5 search finds the right rows', () => {
    emitDecided(bus, 'r-env', { args: { path: '.env' } })
    emitDecided(bus, 'r-auth', { args: { path: 'src/auth.ts' } })
    audit.flush()
    const hits = sqlite
      .prepare(
        `SELECT request_id FROM requests_fts WHERE requests_fts MATCH ?`,
      )
      .all('env') as { request_id: string }[]
    expect(hits.map((h) => h.request_id)).toEqual(['r-env'])
  })

  it('auto-flushes after the configured interval', async () => {
    audit.dispose()
    audit = new AuditLogger(db, bus, { flushIntervalMs: 50 })
    emitDecided(bus, 'r1')
    emitDecided(bus, 'r2')
    expect(audit.pendingCount()).toBe(2)
    await new Promise((resolve) => setTimeout(resolve, 120))
    const count = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM requests`)
      .get() as { n: number }
    expect(count.n).toBe(2)
    expect(audit.pendingCount()).toBe(0)
  })

  it('flushes immediately when the batch cap is reached', () => {
    audit.dispose()
    audit = new AuditLogger(db, bus, { flushMaxBatch: 5 })
    for (let i = 0; i < 5; i++) emitDecided(bus, `r${i}`)
    expect(audit.pendingCount()).toBe(0)
    const count = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM requests`)
      .get() as { n: number }
    expect(count.n).toBe(5)
  })

  it('logs agent:registered, policy:changed, session:halted to audit_events', () => {
    const now = Date.now()
    bus.emit('agent:registered', {
      agentId: 'hermes',
      displayName: 'Hermes',
      transport: 'stdio',
      registeredAt: now,
    })
    bus.emit('policy:changed', {
      ruleId: 7,
      sourceAgent: 'hermes',
      target: 'claude-code:read_file',
      effect: 'deny',
      createdBy: 'remember-action',
      changedAt: now,
    })
    bus.emit('session:halted', {
      sessionId: 's1',
      reason: 'turn_limit',
      turnCount: 6,
      tokenCount: 1200,
      haltedAt: now,
    })
    audit.flush()
    const types = db
      .select({ eventType: auditEvents.eventType })
      .from(auditEvents)
      .all()
      .map((r) => r.eventType)
      .sort()
    expect(types).toEqual([
      'agent_registered',
      'policy_changed',
      'session_halted',
    ])
  })

  it('dispose() unsubscribes — later events are not captured', () => {
    audit.dispose()
    emitDecided(bus, 'r-after-dispose')
    const count = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM requests`)
      .get() as { n: number }
    expect(count.n).toBe(0)
    // recreate for the afterEach cleanup to have something to dispose
    audit = new AuditLogger(db, bus)
  })
})
