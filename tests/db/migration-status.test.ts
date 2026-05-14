import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  backupDb,
  getMigrationStatus,
} from "../../src/db/migration-status.js";
import { getForemanPaths } from "../../src/utils/config.js";

describe("migration-status", () => {
  let tmpDir: string;
  let dbPath: string;
  let migrationsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "foreman-mig-"));
    dbPath = join(tmpDir, "foreman.db");
    migrationsPath = getForemanPaths().migrationsPath;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getMigrationStatus", () => {
    it("reports every journal entry as pending when the DB does not exist", () => {
      const status = getMigrationStatus(dbPath, migrationsPath);
      expect(status.appliedCount).toBe(0);
      expect(status.pendingCount).toBeGreaterThan(0);
      expect(status.pendingTags.length).toBe(status.pendingCount);
    });

    it("reports zero pending after applyMigrations runs", () => {
      const before = getMigrationStatus(dbPath, migrationsPath);
      const result = applyMigrations(dbPath, migrationsPath);
      expect(result.appliedNow).toBe(before.pendingCount);
      const after = getMigrationStatus(dbPath, migrationsPath);
      expect(after.pendingCount).toBe(0);
      expect(after.appliedCount).toBe(before.pendingCount);
    });

    it("is idempotent — a second applyMigrations is a no-op", () => {
      applyMigrations(dbPath, migrationsPath);
      const result = applyMigrations(dbPath, migrationsPath);
      expect(result.appliedNow).toBe(0);
    });

    it("handles a DB that exists but lacks the drizzle migrations table", () => {
      // Empty DB with no migrations table.
      const sqlite = new Database(dbPath);
      sqlite.exec("CREATE TABLE foo (id INTEGER PRIMARY KEY)");
      sqlite.close();
      const status = getMigrationStatus(dbPath, migrationsPath);
      expect(status.appliedCount).toBe(0);
      expect(status.pendingCount).toBeGreaterThan(0);
    });
  });

  describe("backupDb", () => {
    it("creates foreman.db.bak with the same bytes", () => {
      applyMigrations(dbPath, migrationsPath);
      const original = readFileSync(dbPath);
      const bak = backupDb(dbPath);
      expect(bak).toBe(`${dbPath}.bak`);
      const copied = readFileSync(`${dbPath}.bak`);
      expect(copied.equals(original)).toBe(true);
    });

    it("returns null when there is nothing to back up", () => {
      const missing = join(tmpDir, "does-not-exist.db");
      expect(backupDb(missing)).toBeNull();
    });

    it("overwrites an existing .bak (subsequent backups stomp on the last one)", () => {
      applyMigrations(dbPath, migrationsPath);
      backupDb(dbPath);
      // Modify the live DB so the next backup is byte-different.
      const sqlite = new Database(dbPath);
      sqlite.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY)");
      sqlite.close();
      backupDb(dbPath);
      const liveSize = readFileSync(dbPath).length;
      const bakSize = readFileSync(`${dbPath}.bak`).length;
      expect(bakSize).toBe(liveSize);
    });
  });
});

// Unused import suppression — Database is imported for an inline test above.
void writeFileSync;
