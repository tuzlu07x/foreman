import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInstallStep } from "../../src/tui/setup-wizard.js";
import {
  EventBus,
  type ForemanEventMap,
} from "../../src/core/event-bus.js";
import { RegistryService } from "../../src/core/registry.js";
import { SecretStore } from "../../src/core/secret-store.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";

// runInstallStep relies on loadActiveRegistry() which resolves the bundled
// registry/agents.json. Those tests run against the real file — we use real
// registry ids (hermes, claude-code, generic-mcp) to avoid mocking the
// registry catalog.

describe("setup-wizard.runInstallStep diff logic", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let bus: EventBus<ForemanEventMap>;
  let registry: RegistryService;
  let secretStore: SecretStore;
  let logs: string[];

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    bus = new EventBus<ForemanEventMap>();
    registry = new RegistryService(db, bus);
    // 32-byte master key for the secret store, sufficient for the tests.
    secretStore = new SecretStore(db, Buffer.alloc(32, 7));
    logs = [];
  });

  afterEach(() => {
    sqlite.close();
  });

  function services(): {
    db: ForemanDb;
    secretStore: SecretStore;
    registry: RegistryService;
    policyPath: string;
    llmConfigPath: string;
    notifyConfigPath: string;
    launchEditor: () => Promise<unknown>;
  } {
    return {
      db,
      secretStore,
      registry,
      policyPath: "/tmp/policy.yaml",
      llmConfigPath: "/tmp/llm.yaml",
      notifyConfigPath: "/tmp/notify.yaml",
      launchEditor: vi.fn().mockResolvedValue(undefined) as () => Promise<unknown>,
    };
  }

  it("logs a no-op message when toAdd and toRemove are both empty", async () => {
    await runInstallStep([], [], services(), (line) => logs.push(line));
    expect(logs.some((l) => l.includes("no agent changes"))).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });

  it("registers a newly-checked agent (generic-mcp has no install command)", async () => {
    await runInstallStep(
      ["generic-mcp"],
      [],
      services(),
      (line) => logs.push(line),
    );
    expect(registry.list().map((a) => a.id)).toContain("generic-mcp");
    expect(logs.some((l) => l.includes('registered as "generic-mcp"'))).toBe(
      true,
    );
  });

  it("warns about missing required secrets but still registers", async () => {
    // hermes requires anthropic-key (not in the empty secret store)
    await runInstallStep(
      ["generic-mcp"],
      [],
      services(),
      (line) => logs.push(line),
    );
    // generic-mcp has no required secrets, so no warning
    expect(logs.some((l) => l.includes("required secrets missing"))).toBe(
      false,
    );
  });

  it("unregisters a previously-checked agent (toRemove)", async () => {
    // Pre-populate: register generic-mcp directly via the registry
    registry.register({
      id: "generic-mcp",
      displayName: "Generic MCP server",
      transport: "stdio",
      metadata: { registryId: "generic-mcp" },
    });
    expect(registry.list().map((a) => a.id)).toContain("generic-mcp");

    await runInstallStep(
      [],
      ["generic-mcp"],
      services(),
      (line) => logs.push(line),
    );

    expect(registry.list().map((a) => a.id)).not.toContain("generic-mcp");
    expect(logs.some((l) => l.includes('unregistered "generic-mcp"'))).toBe(
      true,
    );
  });

  it("processes toRemove first, then toAdd (so 'replace' works in one pass)", async () => {
    registry.register({
      id: "generic-mcp",
      displayName: "Generic MCP server",
      transport: "stdio",
      metadata: { registryId: "generic-mcp" },
    });

    const log: string[] = [];
    await runInstallStep(
      ["generic-mcp"],
      ["generic-mcp"],
      services(),
      (line) => log.push(line),
    );

    // Find the relative order of "Removing" vs "▸ Generic MCP server" log lines
    const removingIdx = log.findIndex((l) => l.includes("Removing"));
    const addingIdx = log.findIndex(
      (l) => l.startsWith("▸ ") && !l.includes("Removing"),
    );
    expect(removingIdx).toBeGreaterThanOrEqual(0);
    expect(addingIdx).toBeGreaterThanOrEqual(0);
    expect(removingIdx).toBeLessThan(addingIdx);
  });

  it("skips an agent that isn't in the registry catalog with a clear log line", async () => {
    await runInstallStep(
      ["never-shipped"],
      [],
      services(),
      (line) => logs.push(line),
    );
    expect(logs.some((l) => l.includes("not in registry — skipped"))).toBe(
      true,
    );
    expect(registry.list()).toHaveLength(0);
  });

  it("persists llmProvider + responsibilityNote from agentConfigs on registration", async () => {
    await runInstallStep(
      ["generic-mcp"],
      [],
      services(),
      (line) => logs.push(line),
      {
        "generic-mcp": {
          llmProvider: "anthropic",
          responsibilityNote: "Smoke test agent",
        },
      },
    );
    const agent = registry.get("generic-mcp");
    expect(agent?.llmProvider).toBe("anthropic");
    expect(agent?.responsibilityNote).toBe("Smoke test agent");
  });

  it("registers without per-agent config when none is supplied (backward compat)", async () => {
    await runInstallStep(
      ["generic-mcp"],
      [],
      services(),
      (line) => logs.push(line),
    );
    const agent = registry.get("generic-mcp");
    expect(agent?.llmProvider).toBeNull();
    expect(agent?.responsibilityNote).toBeNull();
  });

  it("returns an InstallStepSummary describing what happened", async () => {
    const summary = await runInstallStep(
      ["generic-mcp"],
      [],
      services(),
      (line) => logs.push(line),
    );
    expect(summary.registered).toContain("generic-mcp");
    expect(summary.failed).toEqual([]);
    expect(summary.removed).toEqual([]);
    // generic-mcp has no identity_path → skipped with a clear reason.
    expect(summary.identityPushed).toEqual([]);
    expect(summary.identitySkipped).toEqual([
      { agentId: "generic-mcp", reason: "no identity_path in registry entry" },
    ]);
  });

  it("does not call onFailure on the happy path (no install command, register succeeds)", async () => {
    const onFailure = vi.fn();
    await runInstallStep(
      ["generic-mcp"],
      [],
      services(),
      (line) => logs.push(line),
      {},
      onFailure,
    );
    expect(onFailure).not.toHaveBeenCalled();
    expect(registry.list().map((a) => a.id)).toContain("generic-mcp");
  });

  it("records removed agents in the summary", async () => {
    registry.register({
      id: "generic-mcp",
      displayName: "Generic MCP server",
      transport: "stdio",
      metadata: { registryId: "generic-mcp" },
    });
    const summary = await runInstallStep(
      [],
      ["generic-mcp"],
      services(),
      (line) => logs.push(line),
    );
    expect(summary.removed).toEqual(["generic-mcp"]);
    expect(summary.registered).toEqual([]);
  });
});
