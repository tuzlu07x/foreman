import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus, type ForemanEventMap } from "../../src/core/event-bus.js";
import {
  PolicyEngine,
  PolicyRuleNotFoundError,
} from "../../src/core/policy-engine.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";

describe("PolicyEngine.setEnabled", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let bus: EventBus<ForemanEventMap>;
  let engine: PolicyEngine;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    bus = new EventBus<ForemanEventMap>();
    engine = new PolicyEngine(db, bus);
    engine.loadYamlText(`
agents:
  hermes:
    can_call:
      claude-code: [read_file]
`);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("toggles a rule off, evaluate falls through to ask", () => {
    const rule = engine.list()[0]!;
    expect(rule.enabled).toBe(1);
    engine.setEnabled(rule.id, false);
    const reloaded = engine.list().find((r) => r.id === rule.id)!;
    expect(reloaded.enabled).toBe(0);
    const evalResult = engine.evaluate({
      sourceAgent: "hermes",
      targetAgent: "claude-code",
      targetTool: "read_file",
    });
    expect(evalResult.decision).toBe("ask");
  });

  it("re-enables a disabled rule", () => {
    const rule = engine.list()[0]!;
    engine.setEnabled(rule.id, false);
    engine.setEnabled(rule.id, true);
    const reloaded = engine.list().find((r) => r.id === rule.id)!;
    expect(reloaded.enabled).toBe(1);
    const evalResult = engine.evaluate({
      sourceAgent: "hermes",
      targetAgent: "claude-code",
      targetTool: "read_file",
    });
    expect(evalResult.decision).toBe("allow");
  });

  it("emits policy:changed with the right metadata", () => {
    const handler = vi.fn();
    bus.on("policy:changed", handler);
    const rule = engine.list()[0]!;
    engine.setEnabled(rule.id, false);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleId: rule.id,
        sourceAgent: "hermes",
        target: "claude-code:read_file",
        effect: "allow",
      }),
    );
  });

  it("throws PolicyRuleNotFoundError for unknown id", () => {
    expect(() => engine.setEnabled(999_999, false)).toThrow(
      PolicyRuleNotFoundError,
    );
  });
});
