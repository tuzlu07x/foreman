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

describe("RegistryService — per-agent config (llmProvider + responsibilityNote)", () => {
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

  describe("register", () => {
    it("persists llmProvider + responsibilityNote when supplied", () => {
      const { agent } = registry.register({
        id: "openclaw",
        displayName: "OpenClaw",
        transport: "stdio",
        llmProvider: "anthropic",
        responsibilityNote: "Daily personal assistant",
      });
      expect(agent.llmProvider).toBe("anthropic");
      expect(agent.responsibilityNote).toBe("Daily personal assistant");
    });

    it("stores NULL for both fields when omitted (backward compat)", () => {
      const { agent } = registry.register({
        id: "hermes",
        displayName: "Hermes",
        transport: "stdio",
      });
      expect(agent.llmProvider).toBeNull();
      expect(agent.responsibilityNote).toBeNull();
    });

    it("supports llmProvider without responsibilityNote", () => {
      const { agent } = registry.register({
        id: "openclaw",
        displayName: "OpenClaw",
        transport: "stdio",
        llmProvider: "openai",
      });
      expect(agent.llmProvider).toBe("openai");
      expect(agent.responsibilityNote).toBeNull();
    });

    it("supports responsibilityNote without llmProvider (single-provider agent)", () => {
      const { agent } = registry.register({
        id: "claude-code",
        displayName: "Claude Code",
        transport: "stdio",
        responsibilityNote: "Code review",
      });
      expect(agent.llmProvider).toBeNull();
      expect(agent.responsibilityNote).toBe("Code review");
    });

    it("list() and get() surface the new fields", () => {
      registry.register({
        id: "openclaw",
        displayName: "OpenClaw",
        transport: "stdio",
        llmProvider: "anthropic",
        responsibilityNote: "Daily assistant",
      });
      const fromGet = registry.get("openclaw");
      expect(fromGet?.llmProvider).toBe("anthropic");
      expect(fromGet?.responsibilityNote).toBe("Daily assistant");
      const fromList = registry.list();
      expect(fromList[0]?.llmProvider).toBe("anthropic");
    });
  });

  describe("setLlmProvider", () => {
    beforeEach(() => {
      registry.register({
        id: "hermes",
        displayName: "Hermes",
        transport: "stdio",
        llmProvider: "anthropic",
      });
    });

    it("updates the row and emits agent:config-updated", () => {
      const seen: Array<{
        agentId: string;
        llmProvider: string | null;
        responsibilityNote: string | null;
      }> = [];
      bus.on("agent:config-updated", (e) => {
        seen.push({
          agentId: e.agentId,
          llmProvider: e.llmProvider,
          responsibilityNote: e.responsibilityNote,
        });
      });
      registry.setLlmProvider("hermes", "openai");
      expect(registry.get("hermes")?.llmProvider).toBe("openai");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.llmProvider).toBe("openai");
    });

    it("accepts null to clear the choice", () => {
      registry.setLlmProvider("hermes", null);
      expect(registry.get("hermes")?.llmProvider).toBeNull();
    });

    it("preserves responsibilityNote when only llmProvider changes", () => {
      registry.setResponsibilityNote("hermes", "Telegram channel");
      registry.setLlmProvider("hermes", "openai");
      const agent = registry.get("hermes");
      expect(agent?.llmProvider).toBe("openai");
      expect(agent?.responsibilityNote).toBe("Telegram channel");
    });

    it("throws AgentNotFoundError for an unknown id", () => {
      expect(() => registry.setLlmProvider("ghost", "openai")).toThrow(
        AgentNotFoundError,
      );
    });
  });

  describe("setResponsibilityNote", () => {
    beforeEach(() => {
      registry.register({
        id: "claude-code",
        displayName: "Claude Code",
        transport: "stdio",
      });
    });

    it("updates the row and emits agent:config-updated", () => {
      const seen: Array<{ note: string | null }> = [];
      bus.on("agent:config-updated", (e) => {
        seen.push({ note: e.responsibilityNote });
      });
      registry.setResponsibilityNote("claude-code", "Code review");
      expect(registry.get("claude-code")?.responsibilityNote).toBe(
        "Code review",
      );
      expect(seen[0]?.note).toBe("Code review");
    });

    it("accepts null to clear the note", () => {
      registry.setResponsibilityNote("claude-code", "Code review");
      registry.setResponsibilityNote("claude-code", null);
      expect(registry.get("claude-code")?.responsibilityNote).toBeNull();
    });

    it("preserves llmProvider when only the note changes", () => {
      registry.setLlmProvider("claude-code", "anthropic");
      registry.setResponsibilityNote("claude-code", "Refactor work");
      const agent = registry.get("claude-code");
      expect(agent?.llmProvider).toBe("anthropic");
      expect(agent?.responsibilityNote).toBe("Refactor work");
    });

    it("throws AgentNotFoundError for an unknown id", () => {
      expect(() =>
        registry.setResponsibilityNote("ghost", "Note"),
      ).toThrow(AgentNotFoundError);
    });
  });
});
