import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EventBus,
  type ForemanEventMap,
} from "../../src/core/event-bus.js";
import { LlmBudgetExceededError } from "../../src/core/llm/client.js";
import type { LlmConfig } from "../../src/core/llm/config.js";
import { OrchestratorChat } from "../../src/core/orchestrator-chat.js";
import { RegistryService } from "../../src/core/registry.js";
import { SecretStore } from "../../src/core/secret-store.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";
import { llmUsage } from "../../src/db/schema.js";

describe("OrchestratorChat (#432)", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let registry: RegistryService;
  let secretStore: SecretStore;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    registry = new RegistryService(db, new EventBus<ForemanEventMap>());
    secretStore = new SecretStore(db, Buffer.alloc(32, 1));
  });

  afterEach(() => {
    sqlite.close();
  });

  function buildConfig(over: Partial<LlmConfig> = {}): LlmConfig {
    return {
      enabled: true,
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      features: {
        verification: false,
        smart_report: false,
        policy_suggestions: false,
        orchestrator_chat: true,
        ...(over.features ?? {}),
      },
      budget: {
        monthly_cap_usd: 5,
        alert_threshold_pct: 80,
        reset_day_of_month: 1,
        ...(over.budget ?? {}),
      },
      credentials: {
        anthropic: { secret_name: "anthropic-key" },
      },
      ...over,
    } as LlmConfig;
  }

  describe("isEnabled", () => {
    it("requires both global enabled + orchestrator_chat feature flag", () => {
      const enabled = new OrchestratorChat({
        db,
        config: buildConfig(),
        secretStore,
        registry,
      });
      expect(enabled.isEnabled()).toBe(true);

      const featureOff = new OrchestratorChat({
        db,
        config: buildConfig({
          features: {
            verification: false,
            smart_report: false,
            policy_suggestions: false,
            orchestrator_chat: false,
          },
        }),
        secretStore,
        registry,
      });
      expect(featureOff.isEnabled()).toBe(false);

      const globalOff = new OrchestratorChat({
        db,
        config: buildConfig({ enabled: false }),
        secretStore,
        registry,
      });
      expect(globalOff.isEnabled()).toBe(false);
    });
  });

  describe("answer", () => {
    it("returns disabled when the feature is off", async () => {
      const chat = new OrchestratorChat({
        db,
        config: buildConfig({
          features: {
            verification: false,
            smart_report: false,
            policy_suggestions: false,
            orchestrator_chat: false,
          },
        }),
        secretStore,
        registry,
      });
      const outcome = await chat.answer({ question: "report" });
      expect(outcome.status).toBe("disabled");
    });

    it("returns failed when no credentials are configured", async () => {
      // Feature is on but anthropic-key isn't in the secret store.
      const chat = new OrchestratorChat({
        db,
        config: buildConfig(),
        secretStore,
        registry,
      });
      const outcome = await chat.answer({ question: "report" });
      expect(outcome.status).toBe("failed");
      if (outcome.status === "failed") {
        expect(outcome.reason.toLowerCase()).toContain("anthropic-key");
      }
    });

    it("returns ok + records usage when the call succeeds", async () => {
      secretStore.add("anthropic-key", "sk-ant-test");
      const fakeResp = {
        text: "The team is idle right now.",
        inputTokens: 100,
        outputTokens: 30,
        costUsd: 0.001,
        durationMs: 200,
        cacheHit: false,
      };
      const chat = new OrchestratorChat({
        db,
        config: buildConfig(),
        secretStore,
        registry,
      });
      // Mock the LLM client's call by patching the factory module's
      // class instance. Simpler: replace the chat's call to its client
      // by monkey-patching the prototype for the duration of this test.
      const AnthropicMod = await import(
        "../../src/core/llm/providers/anthropic.js"
      );
      const callSpy = vi
        .spyOn(AnthropicMod.AnthropicLlmClient.prototype, "call")
        .mockResolvedValue(fakeResp);
      try {
        const outcome = await chat.answer({ question: "report me" });
        expect(outcome.status).toBe("ok");
        if (outcome.status === "ok") {
          expect(outcome.text).toBe("The team is idle right now.");
          expect(outcome.costUsd).toBe(0.001);
        }
        // Usage row should be recorded under orchestrator_chat feature.
        const rows = db.select().from(llmUsage).all();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.feature).toBe("orchestrator_chat");
        expect(rows[0]?.provider).toBe("anthropic");
      } finally {
        callSpy.mockRestore();
      }
    });

    it("returns budget_exceeded when assertBudget throws", async () => {
      secretStore.add("anthropic-key", "sk-ant-test");
      // Seed a usage row that exceeds the cap so assertBudget rejects.
      db.insert(llmUsage)
        .values({
          id: "u1",
          ts: Date.now(),
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          feature: "verification",
          inputTokens: 1000,
          outputTokens: 500,
          costUsd: 100,
          requestId: null,
          durationMs: 100,
          cacheHit: 0,
        })
        .run();
      const chat = new OrchestratorChat({
        db,
        config: buildConfig(),
        secretStore,
        registry,
      });
      const outcome = await chat.answer({ question: "report" });
      expect(outcome.status).toBe("budget_exceeded");
      if (outcome.status === "budget_exceeded") {
        expect(outcome.capUsd).toBe(5);
      }
    });

    it("propagates LlmBudgetExceededError that surfaces mid-call", async () => {
      secretStore.add("anthropic-key", "sk-ant-test");
      const chat = new OrchestratorChat({
        db,
        config: buildConfig(),
        secretStore,
        registry,
      });
      const AnthropicMod = await import(
        "../../src/core/llm/providers/anthropic.js"
      );
      const callSpy = vi
        .spyOn(AnthropicMod.AnthropicLlmClient.prototype, "call")
        .mockRejectedValue(new LlmBudgetExceededError(10, 5));
      try {
        const outcome = await chat.answer({ question: "report" });
        expect(outcome.status).toBe("budget_exceeded");
      } finally {
        callSpy.mockRestore();
      }
    });

    it("returns empty_response when the LLM gives empty text", async () => {
      secretStore.add("anthropic-key", "sk-ant-test");
      const chat = new OrchestratorChat({
        db,
        config: buildConfig(),
        secretStore,
        registry,
      });
      const AnthropicMod = await import(
        "../../src/core/llm/providers/anthropic.js"
      );
      const callSpy = vi
        .spyOn(AnthropicMod.AnthropicLlmClient.prototype, "call")
        .mockResolvedValue({
          text: "   ",
          inputTokens: 50,
          outputTokens: 0,
          costUsd: 0,
          durationMs: 50,
          cacheHit: false,
        });
      try {
        const outcome = await chat.answer({ question: "report" });
        expect(outcome.status).toBe("empty_response");
      } finally {
        callSpy.mockRestore();
      }
    });
  });
});
