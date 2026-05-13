import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus, type ForemanEventMap } from "../../src/core/event-bus.js";
import { PolicyEngine } from "../../src/core/policy-engine.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";

describe("PolicyEngine.evaluateSecretAccess", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let engine: PolicyEngine;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    engine = new PolicyEngine(db, new EventBus<ForemanEventMap>());
  });

  afterEach(() => sqlite.close());

  it("denies by default when no rule is configured for the agent", () => {
    const result = engine.evaluateSecretAccess("hermes", "anthropic-key");
    expect(result.decision).toBe("deny");
    expect(result.decidedBy).toBe("policy:deny-by-default");
  });

  it("allows access when YAML grants can_access_secrets", () => {
    engine.loadYamlText(`
agents:
  hermes:
    can_access_secrets:
      - anthropic-key
`);
    const result = engine.evaluateSecretAccess("hermes", "anthropic-key");
    expect(result.decision).toBe("allow");
    expect(result.decidedBy).toMatch(/^policy:\d+$/);
  });

  it("denies with policy:cannot_access_secrets when explicitly blocked", () => {
    engine.loadYamlText(`
agents:
  hermes:
    cannot_access_secrets:
      - openai-key
`);
    const result = engine.evaluateSecretAccess("hermes", "openai-key");
    expect(result.decision).toBe("deny");
    expect(result.decidedBy).toBe("policy:cannot_access_secrets");
  });

  it("deny wins when both can and cannot list the same secret", () => {
    engine.loadYamlText(`
agents:
  hermes:
    can_access_secrets:
      - shared-key
    cannot_access_secrets:
      - shared-key
`);
    const result = engine.evaluateSecretAccess("hermes", "shared-key");
    expect(result.decision).toBe("deny");
  });

  it("isolates secrets across agents — hermes' grant does not let claude-code in", () => {
    engine.loadYamlText(`
agents:
  hermes:
    can_access_secrets:
      - anthropic-key
`);
    expect(engine.evaluateSecretAccess("claude-code", "anthropic-key").decision).toBe(
      "deny",
    );
  });
});
