import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getForemanPaths } from "../utils/config.js";
import * as schema from "./schema.js";

export type ForemanDb = BetterSQLite3Database<typeof schema>;

let cached: { sqlite: Database.Database; db: ForemanDb } | null = null;

/**
 * Lazily open the SQLite file at `~/.foreman/foreman.db`, apply any
 * pending migrations, and return a typed Drizzle client. Repeat callers
 * get the same handle.
 */
export function getDb(): ForemanDb {
  if (cached) return cached.db;
  const { dbPath, migrationsPath } = getForemanPaths();
  mkdirSync(dirname(dbPath), { recursive: true });
  let sqlite: Database.Database;
  try {
    sqlite = new Database(dbPath);
    configureSqlite(sqlite);
  } catch (err) {
    throw wrapDbOpenError(err, dbPath);
  }
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsPath });
  cached = { sqlite, db };
  return db;
}

function wrapDbOpenError(err: unknown, dbPath: string): Error {
  const code =
    err instanceof Error && "code" in err && typeof err.code === "string"
      ? err.code
      : null;
  if (code === "SQLITE_NOTADB") {
    const friendly = new Error(
      `${dbPath} is not a valid Foreman database (corrupt or wrong file format).\n  → Restore from backup, or move it aside and run 'foreman init' to recreate.`,
    );
    (friendly as Error & { foremanFriendly?: boolean }).foremanFriendly = true;
    return friendly;
  }
  if (code === "SQLITE_CORRUPT") {
    const friendly = new Error(
      `${dbPath} is corrupt.\n  → Restore from backup, or move it aside and run 'foreman init' to recreate.`,
    );
    (friendly as Error & { foremanFriendly?: boolean }).foremanFriendly = true;
    return friendly;
  }
  return err instanceof Error ? err : new Error(String(err));
}

export function getSqlite(): Database.Database {
  getDb();
  return cached!.sqlite;
}

/** Close the cached handle. Mostly useful in tests and on shutdown. */
export function closeDb(): void {
  if (!cached) return;
  cached.sqlite.close();
  cached = null;
}

/**
 * Build a fully-migrated in-memory database. Used by tests and any code
 * path that wants an isolated, throwaway DB. The caller owns the handle.
 */
export function createInMemoryDb(): {
  db: ForemanDb;
  sqlite: Database.Database;
} {
  const sqlite = new Database(":memory:");
  configureSqlite(sqlite);
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: getForemanPaths().migrationsPath });
  return { db, sqlite };
}

function configureSqlite(sqlite: Database.Database): void {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = NORMAL");
}
