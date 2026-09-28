import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite from 'better-sqlite3'
import type Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import type { ForemanDb } from '../../src/db/client.js'
import * as schema from '../../src/db/schema.js'
import { getForemanPaths } from '../../src/utils/config.js'

const BETTER_SQLITE = createRequire(import.meta.url).resolve('better-sqlite3')

// `foreman start` loads policy.yaml into the database while agents'
// `foreman mcp-stdio` processes write audit rows. The rule sync read the
// rules and then wrote them in a deferred transaction: when another process
// committed in between, SQLite answered SQLITE_BUSY_SNAPSHOT at once (no
// busy wait) and start died with "policy.yaml failed to parse: database is
// locked" (#594 CI). It now takes the write lock first and waits its turn.
describe('policy.yaml sync while another process writes (#594)', () => {
  let dir: string
  let path: string
  let sqlite: Database.Database
  let db: ForemanDb
  let writer: ChildProcess | null = null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-policy-lock-'))
    path = join(dir, 'foreman.db')
    sqlite = new BetterSqlite(path, { timeout: 5000 })
    sqlite.pragma('journal_mode = WAL')
    db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: getForemanPaths().migrationsPath })
  })

  afterEach(() => {
    writer?.kill()
    writer = null
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Another process takes the write lock, writes, and commits 300 ms later. */
  async function writerHoldingTheLock(): Promise<void> {
    writer = spawn(
      process.execPath,
      [
        '-e',
        `const D = require(${JSON.stringify(BETTER_SQLITE)});
         const db = new D(${JSON.stringify(path)});
         db.exec("BEGIN IMMEDIATE");
         db.prepare("INSERT INTO audit_events (event_type, payload, created_at) VALUES ('test:writer', '{}', ?)").run(Date.now());
         process.stdout.write("locked\\n");
         setTimeout(() => { db.exec("COMMIT"); db.close(); }, 300);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    await new Promise<void>((resolve, reject) => {
      writer!.stdout!.once('data', () => resolve())
      writer!.once('exit', (code) => reject(new Error(`writer exited ${code}`)))
    })
  }

  it('waits for the other writer and stores the rules', async () => {
    const engine = new PolicyEngine(db, new EventBus<ForemanEventMap>())
    await writerHoldingTheLock()
    expect(() =>
      engine.loadYamlText('agents:\n  claude-code:\n    can_call:\n      filesystem: [read_file]\n'),
    ).not.toThrow()
    const rules = sqlite.prepare("SELECT target FROM policies WHERE created_by = 'user'").all()
    expect(rules).toEqual([{ target: 'filesystem:read_file' }])
    const written = sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'test:writer'").get()
    expect(written).toEqual({ n: 1 })
  })
})
