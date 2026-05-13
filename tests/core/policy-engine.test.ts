import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus, type ForemanEventMap } from "../../src/core/event-bus.js";
import { PolicyEngine } from "../../src/core/policy-engine.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";
import { requests } from "../../src/db/schema.js";

function seedRequest(
  db: ForemanDb,
  sourceAgent: string,
  createdAt: number,
  id = `r-${Math.random().toString(36).slice(2)}`,
): void {
  db.insert(requests)
    .values({
      id,
      sourceAgent,
      args: "{}",
      riskScore: 0,
      decision: "allowed",
      createdAt,
    })
    .run();
}

describe("PolicyEngine", () => {
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
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("loadFromYaml — agents form", () => {
    it("translates can_call into allow rules", () => {
      const { rulesAdded } = engine.loadYamlText(`
agents:
  hermes:
    can_call:
      claude-code: [read_file, list_files]
`);
      expect(rulesAdded).toBe(2);
      expect(
        engine
          .list()
          .map((r) => `${r.sourceAgent}:${r.target}:${r.effect}`)
          .sort(),
      ).toEqual([
        "hermes:claude-code:list_files:allow",
        "hermes:claude-code:read_file:allow",
      ]);
    });

    it("translates cannot_call into deny rules", () => {
      engine.loadYamlText(`
agents:
  hermes:
    cannot_call:
      claude-code: [write_file]
`);
      const list = engine.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.effect).toBe("deny");
      expect(list[0]?.target).toBe("claude-code:write_file");
    });

    it("translates rate_limits into a wildcard rule with conditions", () => {
      engine.loadYamlText(`
agents:
  hermes:
    rate_limits:
      messages_per_minute: 30
      tokens_per_hour: 100000
`);
      const list = engine.list();
      expect(list).toHaveLength(1);
      const rule = list[0]!;
      expect(rule.target).toBe("*");
      expect(JSON.parse(rule.conditions!)).toEqual({
        rateLimits: { messagesPerMinute: 30, tokensPerHour: 100000 },
      });
    });

    it("replaces all yaml-loaded rules on reload", () => {
      engine.loadYamlText(`
agents:
  hermes:
    can_call:
      claude-code: [read_file]
`);
      engine.loadYamlText(`
agents:
  hermes:
    can_call:
      claude-code: [list_files]
`);
      const targets = engine.list().map((r) => r.target);
      expect(targets).toEqual(["claude-code:list_files"]);
    });

    it("preserves remember-action rules on reload", () => {
      engine.remember({
        sourceAgent: "hermes",
        target: "tool:shell_exec",
        effect: "deny",
      });
      engine.loadYamlText(`
agents:
  hermes:
    can_call:
      claude-code: [read_file]
`);
      const list = engine.list();
      expect(list.find((r) => r.createdBy === "remember-action")).toBeTruthy();
    });
  });

  describe("loadFromYaml — rules array form", () => {
    it("loads explicit wildcard rules with conditions", () => {
      engine.loadYamlText(`
rules:
  - source: '*'
    target: 'tool:shell_exec'
    effect: deny
  - source: 'claude-code'
    target: 'fs:read_file'
    effect: allow
    conditions:
      pathNotMatch: '\\.env$|\\.key$'
`);
      const list = engine.list();
      expect(list).toHaveLength(2);
      const cond = list.find((r) => r.target === "fs:read_file")!.conditions;
      expect(JSON.parse(cond!).pathNotMatch).toBe("\\.env$|\\.key$");
    });
  });

  describe("evaluate", () => {
    it("returns ask when no rule matches", () => {
      expect(
        engine.evaluate({
          sourceAgent: "hermes",
          targetAgent: "claude-code",
          targetTool: "read_file",
        }),
      ).toEqual({ decision: "ask" });
    });

    it("returns the matched rule effect for an exact source/target", () => {
      engine.loadYamlText(`
agents:
  hermes:
    can_call:
      claude-code: [read_file]
`);
      const result = engine.evaluate({
        sourceAgent: "hermes",
        targetAgent: "claude-code",
        targetTool: "read_file",
      });
      expect(result.decision).toBe("allow");
      expect(result.matchedRuleId).toBeTypeOf("number");
    });

    it("uses wildcard source when no exact source rule matches", () => {
      engine.loadYamlText(`
rules:
  - source: '*'
    target: 'tool:shell_exec'
    effect: deny
`);
      const result = engine.evaluate({
        sourceAgent: "anyone",
        targetTool: "shell_exec",
      });
      expect(result.decision).toBe("deny");
    });

    it("exact-source rule wins over wildcard for the same target", () => {
      engine.loadYamlText(`
rules:
  - source: '*'
    target: 'tool:shell_exec'
    effect: deny
  - source: 'hermes'
    target: 'tool:shell_exec'
    effect: allow
`);
      const hermes = engine.evaluate({
        sourceAgent: "hermes",
        targetTool: "shell_exec",
      });
      const other = engine.evaluate({
        sourceAgent: "other",
        targetTool: "shell_exec",
      });
      expect(hermes.decision).toBe("allow");
      expect(other.decision).toBe("deny");
    });

    it("deny beats allow within the same source/target", () => {
      engine.loadYamlText(`
agents:
  hermes:
    can_call:
      claude-code: [read_file]
    cannot_call:
      claude-code: [read_file]
`);
      const result = engine.evaluate({
        sourceAgent: "hermes",
        targetAgent: "claude-code",
        targetTool: "read_file",
      });
      expect(result.decision).toBe("deny");
    });

    it("skips rules whose pathNotMatch condition fires", () => {
      engine.loadYamlText(`
rules:
  - source: 'claude-code'
    target: 'tool:read_file'
    effect: allow
    conditions:
      pathNotMatch: '\\.env$|\\.key$'
`);
      const ok = engine.evaluate({
        sourceAgent: "claude-code",
        targetTool: "read_file",
        args: { path: "src/auth.ts" },
      });
      const blocked = engine.evaluate({
        sourceAgent: "claude-code",
        targetTool: "read_file",
        args: { path: ".env" },
      });
      expect(ok.decision).toBe("allow");
      expect(blocked.decision).toBe("ask");
    });

    it('targetTool without targetAgent becomes "tool:<name>"', () => {
      engine.loadYamlText(`
rules:
  - source: '*'
    target: 'tool:shell_exec'
    effect: deny
`);
      expect(
        engine.evaluate({ sourceAgent: "hermes", targetTool: "shell_exec" }),
      ).toMatchObject({ decision: "deny" });
    });
  });

  describe("rate limits", () => {
    it("passes through when under the per-minute limit", () => {
      engine.loadYamlText(`
agents:
  hermes:
    rate_limits:
      messages_per_minute: 30
    can_call:
      claude-code: [read_file]
`);
      for (let i = 0; i < 5; i++)
        seedRequest(db, "hermes", Date.now() - 30_000, `r${i}`);
      const result = engine.evaluate({
        sourceAgent: "hermes",
        targetAgent: "claude-code",
        targetTool: "read_file",
      });
      expect(result.decision).toBe("allow");
    });

    it("returns deny when the per-minute limit is exceeded", () => {
      engine.loadYamlText(`
agents:
  hermes:
    rate_limits:
      messages_per_minute: 3
    can_call:
      claude-code: [read_file]
`);
      const now = Date.now();
      for (let i = 0; i < 3; i++)
        seedRequest(db, "hermes", now - 1_000, `r${i}`);
      const result = engine.evaluate({
        sourceAgent: "hermes",
        targetAgent: "claude-code",
        targetTool: "read_file",
      });
      expect(result.decision).toBe("deny");
    });

    it("ignores requests older than 60 seconds", () => {
      engine.loadYamlText(`
agents:
  hermes:
    rate_limits:
      messages_per_minute: 1
    can_call:
      claude-code: [read_file]
`);
      seedRequest(db, "hermes", Date.now() - 90_000);
      const result = engine.evaluate({
        sourceAgent: "hermes",
        targetAgent: "claude-code",
        targetTool: "read_file",
      });
      expect(result.decision).toBe("allow");
    });
  });

  describe("remember", () => {
    it("inserts a remember-action rule and emits policy:changed", () => {
      const handler = vi.fn();
      bus.on("policy:changed", handler);
      const id = engine.remember({
        sourceAgent: "hermes",
        target: "tool:shell_exec",
        effect: "deny",
      });
      expect(id).toBeGreaterThan(0);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          ruleId: id,
          createdBy: "remember-action",
          effect: "deny",
        }),
      );
      const rule = engine.list().find((r) => r.id === id);
      expect(rule?.createdBy).toBe("remember-action");
    });

    it("remembered rules immediately affect evaluate()", () => {
      engine.remember({
        sourceAgent: "hermes",
        target: "claude-code:write_file",
        effect: "deny",
      });
      const result = engine.evaluate({
        sourceAgent: "hermes",
        targetAgent: "claude-code",
        targetTool: "write_file",
      });
      expect(result.decision).toBe("deny");
    });
  });
});
