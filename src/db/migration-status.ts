import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

export interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

export interface MigrationStatus {
  /** Number of migrations recorded as applied in __drizzle_migrations. */
  appliedCount: number;
  /** Number of journal entries the DB has not yet applied. */
  pendingCount: number;
  /** Names (tags) of the pending journal entries, in order. */
  pendingTags: string[];
}

export function readJournal(migrationsPath: string): JournalEntry[] {
  const journalPath = join(migrationsPath, "meta", "_journal.json");
  const raw = JSON.parse(readFileSync(journalPath, "utf-8")) as {
    entries?: JournalEntry[];
  };
  return raw.entries ?? [];
}

export function getMigrationStatus(
  dbPath: string,
  migrationsPath: string,
): MigrationStatus {
  const journal = readJournal(migrationsPath);
  if (!existsSync(dbPath)) {
    return {
      appliedCount: 0,
      pendingCount: journal.length,
      pendingTags: journal.map((e) => e.tag),
    };
  }
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  let applied: number[];
  try {
    applied = sqlite
      .prepare(
        "SELECT created_at FROM __drizzle_migrations ORDER BY created_at",
      )
      .all()
      .map((r) => (r as { created_at: number }).created_at);
  } catch {
    // Table doesn't exist yet — fresh DB, every journal entry is pending.
    applied = [];
  } finally {
    sqlite.close();
  }
  const appliedSet = new Set(applied);
  const pending = journal.filter((e) => !appliedSet.has(e.when));
  return {
    appliedCount: applied.length,
    pendingCount: pending.length,
    pendingTags: pending.map((e) => e.tag),
  };
}

export function backupDb(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;
  const bakPath = `${dbPath}.bak`;
  copyFileSync(dbPath, bakPath);
  return bakPath;
}

// Applies any pending migrations against the given DB. Throws on the
// underlying drizzle/better-sqlite3 errors.
export function applyMigrations(
  dbPath: string,
  migrationsPath: string,
): { appliedNow: number } {
  const before = getMigrationStatus(dbPath, migrationsPath);
  if (before.pendingCount === 0) return { appliedNow: 0 };
  const sqlite = new Database(dbPath);
  try {
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: migrationsPath });
  } finally {
    sqlite.close();
  }
  return { appliedNow: before.pendingCount };
}
