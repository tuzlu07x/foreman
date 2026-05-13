import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus, type ForemanEventMap } from "../../src/core/event-bus.js";
import { SessionManager } from "../../src/core/session.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";

describe("SessionManager.list", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let bus: EventBus<ForemanEventMap>;
  let manager: SessionManager;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    bus = new EventBus<ForemanEventMap>();
    manager = new SessionManager(db, { bus });
  });

  afterEach(() => {
    sqlite.close();
  });

  it("returns every session ordered newest-first", async () => {
    const a = manager.startSession(["x", "y"]);
    await new Promise((r) => setTimeout(r, 2));
    const b = manager.startSession(["y", "z"]);
    await new Promise((r) => setTimeout(r, 2));
    const c = manager.startSession(["z", "w"]);
    const ids = manager.list().map((s) => s.id);
    expect(ids).toEqual([c, b, a]);
  });

  it("includes active, halted, and completed sessions", () => {
    const live = manager.startSession(["a", "b"]);
    const halted = manager.startSession(["c", "d"]);
    const done = manager.startSession(["e", "f"]);
    manager.halt(halted);
    manager.complete(done);
    const statuses = manager
      .list()
      .map((s) => s.status)
      .sort();
    expect(statuses).toEqual(["active", "completed", "halted"]);
    expect(live).toBeTruthy();
  });

  it("participants survive the round-trip", () => {
    manager.startSession(["hermes", "claude-code", "custom"]);
    const row = manager.list()[0]!;
    expect(row.participants).toEqual(["hermes", "claude-code", "custom"]);
  });
});
