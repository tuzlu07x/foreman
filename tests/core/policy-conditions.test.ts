import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus, type ForemanEventMap } from "../../src/core/event-bus.js";
import { PolicyEngine } from "../../src/core/policy-engine.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";

describe("PolicyEngine — pathMatch + commandMatch + conditional priority", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let engine: PolicyEngine;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    engine = new PolicyEngine(db, new EventBus<ForemanEventMap>());
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("pathMatch", () => {
    it("triggers ask when args.path matches one of the regex patterns", () => {
      engine.loadYamlText(`
rules:
  - source: "*"
    target: "tool:read_file"
    effect: ask
    conditions:
      pathMatch:
        - "\\\\.env$"
        - "id_rsa$"
`);
      const result = engine.evaluate({
        sourceAgent: "hermes",
        targetTool: "read_file",
        args: { path: ".env" },
      });
      expect(result.decision).toBe("ask");
      expect(result.matchedRuleId).toBeDefined();
    });

    it("does not trigger when no pattern matches the path", () => {
      engine.loadYamlText(`
rules:
  - source: "*"
    target: "tool:read_file"
    effect: ask
    conditions:
      pathMatch:
        - "\\\\.env$"
`);
      const result = engine.evaluate({
        sourceAgent: "hermes",
        targetTool: "read_file",
        args: { path: "README.md" },
      });
      expect(result.decision).toBe("ask"); // falls through to default
      expect(result.matchedRuleId).toBeUndefined();
    });

    it("fails safe on an invalid regex: restrictive rules still apply", () => {
      engine.loadYamlText(`
rules:
  - source: "*"
    target: "tool:read_file"
    effect: ask
    conditions:
      pathMatch:
        - "[invalid"
`);
      const result = engine.evaluate({
        sourceAgent: "hermes",
        targetTool: "read_file",
        args: { path: "x" },
      });
      expect(result.decision).toBe("ask");
      expect(result.matchedRuleId).toBeDefined();
    });

    it("a glob typed as a regex no longer disables a deny rule (\"*.env\")", () => {
      engine.loadYamlText(`
rules:
  - source: "*"
    target: "tool:read_file"
    effect: deny
    conditions:
      pathMatch: ["*.env"]
  - source: "*"
    target: "tool:read_file"
    effect: allow
`);
      expect(
        engine.evaluate({ sourceAgent: "hermes", targetTool: "read_file", args: { path: ".env" } })
          .decision,
      ).toBe("deny");
    });

    it("an invalid regex never broadens an allow rule", () => {
      engine.loadYamlText(`
rules:
  - source: "*"
    target: "tool:read_file"
    effect: allow
    conditions:
      pathMatch: ["[bad"]
`);
      expect(
        engine.evaluate({ sourceAgent: "hermes", targetTool: "read_file", args: { path: "/etc/shadow" } })
          .decision,
      ).toBe("ask");
    });

    it("matches every path-like key, case-insensitively and after normalisation", () => {
      engine.loadYamlText(`
rules:
  - source: "*"
    target: "tool:read_file"
    effect: ask
    conditions:
      pathMatch: ["(^|/)\\\\.env$"]
  - source: "*"
    target: "tool:read_file"
    effect: allow
`);
      const ask = (args: unknown) =>
        engine.evaluate({ sourceAgent: "hermes", targetTool: "read_file", args }).decision;
      expect(ask({ file_path: "/p/.env" })).toBe("ask");
      expect(ask({ path: "/p/.ENV" })).toBe("ask");
      expect(ask({ paths: ["/p/README.md", "/p/.env"] })).toBe("ask");
      expect(ask({ path: "/p/docs/../.env" })).toBe("ask");
      expect(ask({ path: "/p/src/index.ts" })).toBe("allow");
    });
  });

  describe("precedence", () => {
    it("a remembered per-agent allow does not override a targeted .env guard", () => {
      engine.loadYamlText(`
rules:
  - source: "*"
    target: "tool:read_file"
    effect: ask
    conditions:
      pathMatch: ["\\\\.env$"]
`);
      engine.remember({ sourceAgent: "hermes", target: "tool:read_file", effect: "allow" });
      expect(
        engine.evaluate({ sourceAgent: "hermes", targetTool: "read_file", args: { path: "src/a.ts" } })
          .decision,
      ).toBe("allow");
      expect(
        engine.evaluate({ sourceAgent: "hermes", targetTool: "read_file", args: { path: ".env" } })
          .decision,
      ).toBe("ask");
    });

    it("an explicit per-agent deny beats a broader conditional allow", () => {
      engine.loadYamlText(`
rules:
  - source: "hermes"
    target: "tool:read_file"
    effect: deny
  - source: "*"
    target: "tool:read_file"
    effect: allow
    conditions:
      pathMatch: ["^docs/"]
`);
      expect(
        engine.evaluate({ sourceAgent: "hermes", targetTool: "read_file", args: { path: "docs/a.md" } })
          .decision,
      ).toBe("deny");
    });

    it("an explicit per-agent conditional allow can open a wildcard guard", () => {
      engine.loadYamlText(`
rules:
  - source: "*"
    target: "tool:read_file"
    effect: ask
    conditions:
      pathMatch: ["\\\\.env$"]
  - source: "hermes"
    target: "tool:read_file"
    effect: allow
    conditions:
      pathMatch: ["^fixtures/\\\\.env$"]
`);
      expect(
        engine.evaluate({ sourceAgent: "hermes", targetTool: "read_file", args: { path: "fixtures/.env" } })
          .decision,
      ).toBe("allow");
    });
  });

  describe("commandMatch", () => {
    it("triggers ask when a substring is in args.command", () => {
      engine.loadYamlText(`
rules:
  - source: "*"
    target: "tool:shell_exec"
    effect: ask
    conditions:
      commandMatch:
        - "rm -rf"
        - ":(){:|:&};:"
`);
      const result = engine.evaluate({
        sourceAgent: "hermes",
        targetTool: "shell_exec",
        args: { command: "rm -rf /tmp/foo" },
      });
      expect(result.decision).toBe("ask");
    });

    it("considers command + args array when the schema passes both", () => {
      engine.loadYamlText(`
rules:
  - source: "*"
    target: "tool:shell_exec"
    effect: ask
    conditions:
      commandMatch:
        - "chmod 777"
`);
      const result = engine.evaluate({
        sourceAgent: "hermes",
        targetTool: "shell_exec",
        args: { command: "chmod", args: ["777", "secret.key"] },
      });
      expect(result.decision).toBe("ask");
    });

    it("does not trigger on harmless commands", () => {
      engine.loadYamlText(`
rules:
  - source: "*"
    target: "tool:shell_exec"
    effect: ask
    conditions:
      commandMatch:
        - "rm -rf"
        - "| sh"
`);
      const result = engine.evaluate({
        sourceAgent: "hermes",
        targetTool: "shell_exec",
        args: { command: "ls -la" },
      });
      expect(result.matchedRuleId).toBeUndefined();
    });
  });

  describe("conditional-rule priority", () => {
    it("conditional ask wins over a conditionless allow on the same target", () => {
      engine.loadYamlText(`
rules:
  - source: "*"
    target: "tool:read_file"
    effect: ask
    conditions:
      pathMatch: ["\\\\.env$"]
  - source: "*"
    target: "tool:read_file"
    effect: allow
`);
      const ask = engine.evaluate({
        sourceAgent: "hermes",
        targetTool: "read_file",
        args: { path: ".env" },
      });
      expect(ask.decision).toBe("ask");

      const allow = engine.evaluate({
        sourceAgent: "hermes",
        targetTool: "read_file",
        args: { path: "README.md" },
      });
      // Conditional rule skipped → falls through to blanket allow.
      expect(allow.decision).toBe("allow");
    });
  });
});
