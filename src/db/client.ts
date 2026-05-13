import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getForemanPaths } from '../utils/config.js'
import * as schema from './schema.js'

export type ForemanDb = BetterSQLite3Database<typeof schema>

let cached: { sqlite: Database.Database; db: ForemanDb } | null = null

/**
 * Lazily open the SQLite file at `~/.foreman/foreman.db`, apply any
 * pending migrations, and return a typed Drizzle client. Repeat callers
 * get the same handle.
 */
export function getDb(): ForemanDb {
  if (cached) return cached.db
  const { dbPath, migrationsPath } = getForemanPaths()
  mkdirSync(dirname(dbPath), { recursive: true })
  const sqlite = new Database(dbPath)
  configureSqlite(sqlite)
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: migrationsPath })
  cached = { sqlite, db }
  return db
}

/** Close the cached handle. Mostly useful in tests and on shutdown. */
export function closeDb(): void {
  if (!cached) return
  cached.sqlite.close()
  cached = null
}

/**
 * Build a fully-migrated in-memory database. Used by tests and any code
 * path that wants an isolated, throwaway DB. The caller owns the handle.
 */
export function createInMemoryDb(): { db: ForemanDb; sqlite: Database.Database } {
  const sqlite = new Database(':memory:')
  configureSqlite(sqlite)
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: getForemanPaths().migrationsPath })
  return { db, sqlite }
}

function configureSqlite(sqlite: Database.Database): void {
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('synchronous = NORMAL')
}
