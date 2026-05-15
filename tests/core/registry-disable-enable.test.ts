import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EventBus,
  type ForemanEventMap,
} from "../../src/core/event-bus.js";
import {
  AgentNotFoundError,
  RegistryService,
} from "../../src/core/registry.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";
import { sign } from "../../src/identity/signing.js";

describe("RegistryService — disable / enable lifecycle", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let bus: EventBus<ForemanEventMap>;
  let registry: RegistryService;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    bus = new EventBus<ForemanEventMap>();
    registry = new RegistryService(db, bus);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("disable", () => {
    it("sets status to 'disabled' and excludes the agent from list()", () => {
      registry.register({ id: "hermes", displayName: "Hermes", transport: "stdio" });
      registry.disable("hermes");
      expect(registry.get("hermes")?.status).toBe("disabled");
      expect(registry.list()).toHaveLength(0);
    });

    it("still surfaces the agent in listAll() so the TUI can re-enable it", () => {
      registry.register({ id: "hermes", displayName: "Hermes", transport: "stdio" });
      registry.disable("hermes");
      const allRows = registry.listAll();
      expect(allRows.map((a) => a.id)).toEqual(["hermes"]);
      expect(allRows[0]?.status).toBe("disabled");
    });

    it("throws AgentNotFoundError for an unknown agent", () => {
      expect(() => registry.disable("ghost")).toThrow(AgentNotFoundError);
    });

    it("is idempotent — disabling an already-disabled agent is a no-op", () => {
      registry.register({ id: "a", displayName: "A", transport: "stdio" });
      registry.disable("a");
      registry.disable("a");
      expect(registry.get("a")?.status).toBe("disabled");
    });
  });

  describe("enable", () => {
    it("returns a disabled agent to active and back into list()", () => {
      registry.register({ id: "hermes", displayName: "Hermes", transport: "stdio" });
      registry.disable("hermes");
      registry.enable("hermes");
      expect(registry.get("hermes")?.status).toBe("active");
      expect(registry.list().map((a) => a.id)).toEqual(["hermes"]);
    });

    it("throws AgentNotFoundError for an unknown agent", () => {
      expect(() => registry.enable("ghost")).toThrow(AgentNotFoundError);
    });

    it("flips a blocked agent back to active too (no separate unblock needed)", () => {
      // Documents the current behaviour: enable() just sets status='active'.
      // If we want enable() to be disabled-only in the future, surface that here.
      registry.register({ id: "a", displayName: "A", transport: "stdio" });
      registry.block("a");
      registry.enable("a");
      expect(registry.get("a")?.status).toBe("active");
    });
  });

  describe("authenticate", () => {
    it("rejects a disabled agent even with a valid signature", () => {
      const { privateKey } = registry.register({
        id: "hermes",
        displayName: "Hermes",
        transport: "stdio",
      });
      const sig = sign("hi", privateKey!);
      registry.disable("hermes");
      expect(registry.authenticate("hermes", "hi", sig)).toBe(false);
    });

    it("accepts an enabled-again agent's valid signature", () => {
      const { privateKey } = registry.register({
        id: "hermes",
        displayName: "Hermes",
        transport: "stdio",
      });
      const sig = sign("hi", privateKey!);
      registry.disable("hermes");
      registry.enable("hermes");
      expect(registry.authenticate("hermes", "hi", sig)).toBe(true);
    });
  });

  describe("list / listAll interaction", () => {
    it("list() excludes blocked and disabled; listAll() includes both", () => {
      registry.register({ id: "a", displayName: "A", transport: "stdio" });
      registry.register({ id: "b", displayName: "B", transport: "stdio" });
      registry.register({ id: "c", displayName: "C", transport: "stdio" });
      registry.disable("a");
      registry.block("b");
      expect(registry.list().map((x) => x.id)).toEqual(["c"]);
      expect(
        registry
          .listAll()
          .map((x) => x.id)
          .sort(),
      ).toEqual(["a", "b", "c"]);
    });
  });
});
