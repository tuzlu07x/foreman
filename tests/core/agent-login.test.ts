import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgentLoginSteps } from "../../src/core/agent-login.js";
import { SecretStore } from "../../src/core/secret-store.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";

// =============================================================================
// #tui-login — Per-agent login-step resolver used by the dashboard's Agents
// page [o] action. Reuses the wizard's required-setup resolver to turn a
// single registered agent (catalog id + bound provider) into the OAuth /
// interactive_setup command(s) the in-TUI runner executes.
// =============================================================================

describe("resolveAgentLoginSteps", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let store: SecretStore;

  beforeEach(() => {
    const h = createInMemoryDb();
    db = h.db;
    sqlite = h.sqlite;
    store = new SecretStore(db, Buffer.alloc(32, 1));
  });
  afterEach(() => {
    sqlite.close();
  });

  it("returns [] when the agent has no LLM provider bound", () => {
    expect(
      resolveAgentLoginSteps({ registryId: "codex", llmProvider: null }, store),
    ).toEqual([]);
  });

  it("returns [] for an unknown registry id", () => {
    expect(
      resolveAgentLoginSteps(
        { registryId: "does-not-exist", llmProvider: "openai" },
        store,
      ),
    ).toEqual([]);
  });

  it("resolves Codex on openai to its `codex login` OAuth step", () => {
    const steps = resolveAgentLoginSteps(
      { registryId: "codex", llmProvider: "openai" },
      store,
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]?.command).toBe("codex login");
    expect(steps[0]?.verify).toBe("codex login status");
    expect(steps[0]?.mandatory).toBe(true);
  });

  it("returns [] for a pure API-key agent (no interactive login)", () => {
    const steps = resolveAgentLoginSteps(
      { registryId: "openclaw", llmProvider: "openai" },
      store,
    );
    expect(steps).toEqual([]);
  });
});
