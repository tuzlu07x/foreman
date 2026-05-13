import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus, type ForemanEventMap } from "../../src/core/event-bus.js";
import {
  AgentNotFoundError,
  RegistryService,
} from "../../src/core/registry.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";
import { sign, verify } from "../../src/identity/signing.js";

describe("RegistryService.remove", () => {
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

  it("hard-deletes the row and emits agent:removed", () => {
    registry.register({
      id: "hermes",
      displayName: "Hermes",
      transport: "stdio",
    });
    const handler = vi.fn();
    bus.on("agent:removed", handler);
    registry.remove("hermes");
    expect(registry.get("hermes")).toBeNull();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "hermes" }),
    );
  });

  it("throws AgentNotFoundError when removing an unknown agent", () => {
    expect(() => registry.remove("ghost")).toThrow(AgentNotFoundError);
  });

  it("re-add after remove issues a fresh keypair", () => {
    const first = registry.register({
      id: "hermes",
      displayName: "Hermes",
      transport: "stdio",
    });
    registry.remove("hermes");
    const second = registry.register({
      id: "hermes",
      displayName: "Hermes",
      transport: "stdio",
    });
    expect(first.privateKey).toBeDefined();
    expect(second.privateKey).toBeDefined();
    expect(first.privateKey!.equals(second.privateKey!)).toBe(false);
  });
});

describe("RegistryService.regenerateKey", () => {
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

  it("rotates the keypair so old signatures stop verifying", () => {
    const reg = registry.register({
      id: "hermes",
      displayName: "Hermes",
      transport: "stdio",
    });
    const oldPrivate = reg.privateKey!;
    const sigBefore = sign("hello", oldPrivate);
    expect(registry.authenticate("hermes", "hello", sigBefore)).toBe(true);

    const rotation = registry.regenerateKey("hermes");
    expect(rotation.privateKey.equals(oldPrivate)).toBe(false);

    // Old private key no longer matches the agent's stored public key.
    expect(registry.authenticate("hermes", "hello", sigBefore)).toBe(false);
    // New private key works.
    const sigAfter = sign("hello", rotation.privateKey);
    expect(registry.authenticate("hermes", "hello", sigAfter)).toBe(true);
    // Sanity: returned public key matches the new private key.
    expect(verify("hello", sigAfter, rotation.publicKey)).toBe(true);
  });

  it("emits agent:key-rotated", () => {
    registry.register({ id: "a", displayName: "A", transport: "stdio" });
    const handler = vi.fn();
    bus.on("agent:key-rotated", handler);
    registry.regenerateKey("a");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("throws AgentNotFoundError for an unknown agent", () => {
    expect(() => registry.regenerateKey("ghost")).toThrow(AgentNotFoundError);
  });
});
