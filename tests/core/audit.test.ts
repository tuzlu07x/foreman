import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite from 'better-sqlite3'
import type Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuditLogger } from '../../src/core/audit.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import * as schema from '../../src/db/schema.js'
import { auditEvents, requests } from '../../src/db/schema.js'
import { getForemanPaths } from '../../src/utils/config.js'

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
    riskFactors: [],
    riskBucket: 'low',
    llmVerification: null,
    securityReport: null,
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

  it('round-trips risk_factors / risk_bucket / llm_verification when present', () => {
    emitDecided(bus, 'r-rich', {
      riskScore: 70,
      riskReasons: ['secret_file_pattern', 'first_agent_to_agent'],
      riskFactors: [
        {
          rule: 'secret_file_pattern',
          category: 'secret',
          points: 50,
          reason: 'path looks like a credential: .env',
          evidence: '.env',
        },
        {
          rule: 'first_agent_to_agent',
          category: 'structural',
          points: 20,
          reason: 'first hermes → claude-code call in the last hour',
        },
      ],
      riskBucket: 'high',
      llmVerification: null,
    })
    audit.flush()
    const row = db.select().from(requests).all()[0]!
    expect(row.riskBucket).toBe('high')
    expect(row.llmVerification).toBeNull()
    expect(JSON.parse(row.riskFactors!)).toEqual([
      expect.objectContaining({
        rule: 'secret_file_pattern',
        category: 'secret',
        points: 50,
        evidence: '.env',
      }),
      expect.objectContaining({
        rule: 'first_agent_to_agent',
        category: 'structural',
        points: 20,
      }),
    ])
  })

  it('leaves risk_factors NULL (not "[]") when no factors are emitted', () => {
    emitDecided(bus, 'r-empty', {
      riskFactors: [],
      riskBucket: 'low',
    })
    audit.flush()
    const row = db.select().from(requests).all()[0]!
    expect(row.riskFactors).toBeNull()
    expect(row.riskBucket).toBe('low')
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

  // #435 — Agent daemon crashes now persist as audit_events so the
  // activity digest can list them later. Was bus-only before.
  it('logs agent:daemon-crashed to audit_events (#435)', () => {
    bus.emit('agent:daemon-crashed', {
      agentId: 'openclaw',
      pid: 1234,
      exitCode: 1,
      stderr: 'Invalid config',
      crashedAt: Date.now(),
    })
    audit.flush()
    const row = db
      .select()
      .from(auditEvents)
      .all()
      .find((r) => r.eventType === 'agent_daemon_crashed')
    expect(row).toBeDefined()
    const parsed = JSON.parse(row!.payload) as { agentId: string }
    expect(parsed.agentId).toBe('openclaw')
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

// #594 — another process (foreman start, a nested agent's mcp-stdio, the
// TUI) holding the database past the busy timeout. The flush used to throw
// from its timer: an uncaught exception that killed the agent's MCP server
// and dropped the batch.
describe('AuditLogger when another connection holds the lock (#594)', () => {
  let dir: string
  let sqlite: Database.Database
  let db: ForemanDb
  let holder: Database.Database
  let bus: EventBus<ForemanEventMap>
  let audit: AuditLogger
  let reports: string[]

  const count = (table: 'requests' | 'audit_events'): number =>
    (holder.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-audit-lock-'))
    const path = join(dir, 'foreman.db')
    // A short busy timeout keeps the test fast; production waits 5 s.
    sqlite = new BetterSqlite(path, { timeout: 20 })
    sqlite.pragma('journal_mode = WAL')
    db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: getForemanPaths().migrationsPath })
    holder = new BetterSqlite(path)
    bus = new EventBus<ForemanEventMap>()
    reports = []
    audit = new AuditLogger(db, bus, { flushIntervalMs: 10, onError: (m) => reports.push(m) })
  })

  afterEach(() => {
    if (holder.inTransaction) holder.exec('COMMIT')
    try {
      audit.dispose()
    } catch {
      /* the lock test may leave it failing */
    }
    holder.close()
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the batch, reports the error and writes it once the lock clears', async () => {
    holder.exec('BEGIN IMMEDIATE')
    emitDecided(bus, 'r1')
    audit.logEvent('agent:identity', { source: 'hermes' })
    // Timer flush + busy timeout have passed; nothing thrown (vitest fails
    // the run on an uncaught exception), nothing dropped.
    await sleep(80)
    expect(audit.pendingCount()).toBe(2)
    expect(reports[0]).toMatch(/^audit log write failed \(database is locked\); 2 audit entries kept, retrying in \d+ ms$/)
    holder.exec('COMMIT')
    await sleep(400)
    expect(count('requests')).toBe(1)
    expect(count('audit_events')).toBe(1)
    expect(audit.pendingCount()).toBe(0)
    expect(reports.at(-1)).toBe('audit log writes recovered (2 audit entries written)')
  })

  it('flush() throws the lock error to its caller but keeps the entries in order', () => {
    holder.exec('BEGIN IMMEDIATE')
    audit.logEvent('first', {})
    let thrown: unknown
    try {
      audit.flush()
    } catch (err) {
      thrown = err
    }
    expect((thrown as { code?: string }).code).toBe('SQLITE_BUSY')
    audit.logEvent('second', {})
    holder.exec('COMMIT')
    audit.flush()
    const types = holder.prepare('SELECT event_type FROM audit_events ORDER BY id').all() as {
      event_type: string
    }[]
    expect(types.map((t) => t.event_type)).toEqual(['first', 'second'])
  })

  it('a full batch waits for the retry instead of blocking on every new entry', () => {
    audit.dispose()
    audit = new AuditLogger(db, bus, { flushIntervalMs: 1_000, flushMaxBatch: 2, onError: (m) => reports.push(m) })
    holder.exec('BEGIN IMMEDIATE')
    for (let i = 0; i < 10; i++) audit.logEvent(`e${i}`, {})
    // One attempt (at the cap); later entries queue behind the retry timer.
    expect(reports).toHaveLength(1)
    expect(audit.pendingCount()).toBe(10)
  })

  it('stops retrying on its own after a bounded number of attempts', async () => {
    audit.dispose()
    audit = new AuditLogger(db, bus, { flushIntervalMs: 1, onError: (m) => reports.push(m) })
    holder.exec('BEGIN IMMEDIATE')
    audit.logEvent('stuck', {})
    await sleep(1_500)
    const failures = reports.filter((m) => m.startsWith('audit log write failed'))
    expect(failures).toHaveLength(9)
    expect(failures.at(-1)).toMatch(/retrying with the next audit entry or on exit$/)
    // Still kept: the next entry (or dispose) tries again.
    expect(audit.pendingCount()).toBe(1)
    holder.exec('COMMIT')
    audit.logEvent('next', {})
    // The backoff delay (capped), not a tight loop.
    await sleep(700)
    expect(count('audit_events')).toBe(2)
  })

  it('dispose() reports what it could not write and throws', () => {
    holder.exec('BEGIN IMMEDIATE')
    audit.logEvent('last', {})
    expect(() => audit.dispose()).toThrow('database is locked')
    expect(reports.at(-1)).toBe('audit log write failed (database is locked); 1 audit entry not written')
    expect(audit.pendingCount()).toBe(1)
  })
})
