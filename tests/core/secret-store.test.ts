import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SecretAlreadyExistsError,
  SecretNotFoundError,
  SecretStore,
} from "../../src/core/secret-store.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";
import { generateMasterKey } from "../../src/identity/encryption.js";

describe("SecretStore", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let store: SecretStore;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    store = new SecretStore(db, generateMasterKey());
  });

  afterEach(() => {
    sqlite.close();
  });

  it("adds, gets, and lists a secret", () => {
    store.add("anthropic-key", "sk-abc-123");
    expect(store.get("anthropic-key")).toBe("sk-abc-123");
    const rows = store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("anthropic-key");
  });

  it("encrypts the value at rest (no plaintext in DB)", () => {
    store.add("api-key", "VERY_SECRET_VALUE");
    const row = sqlite
      .prepare("SELECT value_encrypted FROM secrets WHERE name = ?")
      .get("api-key") as { value_encrypted: Buffer };
    expect(row.value_encrypted.toString("utf8")).not.toContain(
      "VERY_SECRET_VALUE",
    );
  });

  it("updates last_accessed_at on get()", () => {
    store.add("k", "v");
    expect(store.list()[0]?.lastAccessedAt).toBeNull();
    store.get("k");
    expect(store.list()[0]?.lastAccessedAt).toBeGreaterThan(0);
  });

  it("rejects duplicate adds with SecretAlreadyExistsError", () => {
    store.add("dupe", "first");
    expect(() => store.add("dupe", "second")).toThrow(SecretAlreadyExistsError);
    expect(store.get("dupe")).toBe("first");
  });

  it("rotate() replaces the value and bumps updatedAt", () => {
    store.add("k", "old");
    const before = store.list()[0]?.updatedAt ?? 0;
    // Force a tick so timestamps differ.
    const wait = Date.now() + 5;
    while (Date.now() < wait) {
      /* spin */
    }
    store.rotate("k", "new");
    expect(store.get("k")).toBe("new");
    expect(store.list()[0]?.updatedAt).toBeGreaterThan(before);
  });

  it("rotate() throws when the secret does not exist", () => {
    expect(() => store.rotate("missing", "x")).toThrow(SecretNotFoundError);
  });

  it("remove() drops the row; subsequent get() throws", () => {
    store.add("k", "v");
    store.remove("k");
    expect(store.list()).toHaveLength(0);
    expect(() => store.get("k")).toThrow(SecretNotFoundError);
  });

  it("remove() throws when the secret does not exist", () => {
    expect(() => store.remove("ghost")).toThrow(SecretNotFoundError);
  });

  it("list() never returns the encrypted blob fields", () => {
    store.add("k", "v");
    const row = store.list()[0];
    expect(row).toBeDefined();
    expect(Object.keys(row ?? {})).toEqual([
      "name",
      "createdAt",
      "updatedAt",
      "lastAccessedAt",
    ]);
  });
});
