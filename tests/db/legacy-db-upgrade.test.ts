import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import Database from 'better-sqlite3'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DbApprovalService } from '../../src/core/approval.js'
import { AuditLogger } from '../../src/core/audit.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { RegistryService } from '../../src/core/registry.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { closeDb, createInMemoryDb, getDb, getSqlite } from '../../src/db/client.js'
import { getMigrationStatus, readJournal } from '../../src/db/migration-status.js'
import {
  agents,
  auditEvents,
  pendingApprovals,
  policies,
  requests,
  secrets,
} from '../../src/db/schema.js'
import { getForemanPaths } from '../../src/utils/config.js'

// An existing user's database, opened by the current code (#592).
//
// fixtures/foreman-v0.1.6.db.gz was written by the published
// foreman-agent@0.1.6 (drizzle-orm 0.30.10, better-sqlite3 11.10.0,
// SQLite 3.49.2): `foreman init`, `foreman secrets add fixture-api-key
// --value fixture-not-a-real-secret`, then a few `foreman mcp-stdio` tool
// calls (an allowed read, a timed-out .env read, a pending `rm -rf /`, a
// denied secrets/get). The WAL was checkpointed into the main file and the
// file vacuumed. The encryption key for the secret row is not kept, so the
// ciphertext is inert. 0.1.6 shipped migrations 0000-0022.

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/foreman-v0.1.6.db.gz')
const RELEASED_MIGRATIONS = 23

interface MasterRow {
  type: string
  name: string
  tbl_name: string
  sql: string | null
}

function schemaOf(sqlite: Database.Database): MasterRow[] {
  return sqlite
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as MasterRow[]
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

describe('opening a foreman 0.1.6 database with current code', () => {
  let home: string
  let savedHome: string | undefined
  let dbPath: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-legacy-db-'))
    savedHome = process.env.FOREMAN_HOME
    process.env.FOREMAN_HOME = home
    dbPath = getForemanPaths().dbPath
    mkdirSync(dirname(dbPath), { recursive: true })
    writeFileSync(dbPath, gunzipSync(readFileSync(FIXTURE)))
  })

  afterEach(() => {
    closeDb()
    if (savedHome === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  })

  it('applies only the migrations added since, keeping the recorded history', () => {
    const { migrationsPath } = getForemanPaths()
    const journal = readJournal(migrationsPath)
    const before = getMigrationStatus(dbPath, migrationsPath)
    expect(before.appliedCount).toBe(RELEASED_MIGRATIONS)
    expect(before.pendingTags).toEqual(journal.slice(RELEASED_MIGRATIONS).map((e) => e.tag))

    getDb()
    const after = getMigrationStatus(dbPath, migrationsPath)
    expect(after.pendingCount).toBe(0)
    expect(after.appliedCount).toBe(journal.length)
  })

  it('ends with the same schema as a fresh database', () => {
    getDb()
    const fresh = createInMemoryDb()
    try {
      expect(schemaOf(getSqlite())).toEqual(schemaOf(fresh.sqlite))
    } finally {
      fresh.sqlite.close()
    }
    expect(getSqlite().pragma('integrity_check', { simple: true })).toBe('ok')
    expect(getSqlite().pragma('foreign_key_check')).toEqual([])
  })

  it('keeps the legacy audit trail readable and searchable', async () => {
    const db = getDb()
    const legacy = db.select().from(requests).all()
    expect(legacy.map((r) => [r.targetTool, r.decision])).toEqual([
      ['read_file', 'allowed'],
      ['read_file', 'denied'],
      ['secrets/get', 'denied'],
    ])
    const events = db.select().from(auditEvents).all()
    expect(events.map((e) => e.eventType)).toContain('agent_registered')

    // FTS triggers survive the upgrade: old rows are found, new rows indexed.
    const bus = new EventBus<ForemanEventMap>()
    const audit = new AuditLogger(db, bus, { flushIntervalMs: 1 })
    audit.logRequest({
      id: 'after-upgrade-1',
      sourceAgent: 'legacy-agent',
      targetTool: 'write_file',
      args: JSON.stringify({ path: 'upgrade-marker.txt' }),
      riskScore: 0,
      riskReasons: '[]',
      decision: 'allowed',
      decidedBy: 'policy:test',
      createdAt: Date.now(),
    })
    audit.dispose()
    const match = (q: string): string[] =>
      (
        getSqlite()
          .prepare(
            'SELECT r.id FROM requests_fts f JOIN requests r ON r.rowid = f.rowid WHERE requests_fts MATCH ? ORDER BY r.id',
          )
          .all(q) as Array<{ id: string }>
      ).map((r) => r.id)
    expect(match('env')).toEqual(legacy.filter((r) => r.args?.includes('.env')).map((r) => r.id))
    expect(match('marker')).toEqual(['after-upgrade-1'])
  })

  it('keeps legacy approvals, agents and policies usable by current services', () => {
    const db = getDb()
    const pending = db
      .select()
      .from(pendingApprovals)
      .where(eq(pendingApprovals.status, 'pending'))
      .all()
    expect(pending.length).toBeGreaterThan(0)
    const approvals = new DbApprovalService(db, { bus: new EventBus<ForemanEventMap>() })
    approvals.cancelPending(pending.map((p) => p.requestId))
    const left = db
      .select({ n: sql<number>`count(*)` })
      .from(pendingApprovals)
      .where(eq(pendingApprovals.status, 'pending'))
      .get()
    expect(left?.n).toBe(0)

    const registry = new RegistryService(db, new EventBus<ForemanEventMap>())
    expect(registry.get('legacy-agent')?.status).toBe('active')
    expect(db.select().from(agents).all()).toHaveLength(1)
    expect(db.select().from(policies).all().length).toBeGreaterThan(0)
  })

  it('keeps the secret store working without touching the legacy ciphertext', () => {
    const db = getDb()
    const legacyRow = db.select().from(secrets).where(eq(secrets.name, 'fixture-api-key')).get()
    expect(legacyRow).toBeDefined()
    const store = new SecretStore(db, randomBytes(32))
    expect(store.list().map((s) => s.name)).toEqual(['fixture-api-key'])
    store.add('after-upgrade', 'value-after-upgrade')
    expect(store.get('after-upgrade')).toBe('value-after-upgrade')
    const unchanged = db.select().from(secrets).where(eq(secrets.name, 'fixture-api-key')).get()
    expect(unchanged).toEqual(legacyRow)
    expect(existsSync(dbPath)).toBe(true)
  })
})

describe('released migrations', () => {
  const { migrationsPath } = getForemanPaths()
  const journal = readJournal(migrationsPath)

  // The migrator skips any migration whose `when` is not newer than the
  // last one a database recorded, so an out-of-order entry would silently
  // never run on an existing install (drizzle-kit 0.31.11 warns about it).
  it('have strictly increasing journal timestamps', () => {
    for (let i = 1; i < journal.length; i++) {
      expect(journal[i]!.when, journal[i]!.tag).toBeGreaterThan(journal[i - 1]!.when)
    }
  })

  // Old databases recorded these hashes; an edited released migration
  // would leave them on a schema that fresh installs never see.
  it('are byte-identical to what 0.1.6 applied', () => {
    const legacyPath = join(mkdtempSync(join(tmpdir(), 'foreman-legacy-hash-')), 'legacy.db')
    writeFileSync(legacyPath, gunzipSync(readFileSync(FIXTURE)))
    const legacy = new Database(legacyPath, { readonly: true })
    try {
      const recorded = (
        legacy
          .prepare('SELECT hash FROM __drizzle_migrations ORDER BY created_at')
          .all() as Array<{ hash: string }>
      ).map((r) => r.hash)
      const current = journal
        .slice(0, RELEASED_MIGRATIONS)
        .map((e) => sha256(readFileSync(join(migrationsPath, `${e.tag}.sql`), 'utf-8')))
      expect(current).toEqual(recorded)
    } finally {
      legacy.close()
      rmSync(dirname(legacyPath), { recursive: true, force: true })
    }
  })
})
