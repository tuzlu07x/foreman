import type { ForemanDb } from "../db/client.js";
import type { EventBus, ForemanEventMap } from "./event-bus.js";
import { LlmBudgetExceededError, LlmDisabledError } from "./llm/client.js";
import {
  assertBudget,
  recordUsageAndCheckBudget,
} from "./llm/budget.js";
import {
  isFeatureEnabled,
  type LlmConfig,
} from "./llm/config.js";
import { buildLlmClient } from "./llm/factory.js";
import type { SecretStore } from "./secret-store.js";
import {
  buildOrchestratorPrompt,
  buildOrchestratorSnapshot,
  type OrchestratorSnapshot,
} from "./orchestrator-snapshot.js";
import type { RegistryService } from "./registry.js";

// =============================================================================
// Orchestrator chat (#432)
// =============================================================================
//
// Routes `/foreman report me` / `/foreman <agent> ne yapıyor` /
// free-form `/foreman <text>` through Foreman's own LLM. Reuses the
// existing factory + budget infrastructure so cost is tracked under a
// new feature line `orchestrator_chat` and the global budget cap stays
// effective.

const DEFAULT_MAX_TOKENS = 350;
const DEFAULT_TEMPERATURE = 0.3;

export interface OrchestratorChatOptions {
  db: ForemanDb;
  config: LlmConfig;
  secretStore: SecretStore;
  registry: RegistryService;
  bus?: EventBus<ForemanEventMap>;
}

export interface OrchestratorAnswerInput {
  /** The user's question. For `/foreman report me` this is a default
   *  prompt; for free-form it's the actual text. */
  question: string;
  /** Optional agent focus — set when the user asked about one specific
   *  agent. Drives both the snapshot filter and the prompt's instruction. */
  focusAgentId?: string;
  /** Soft cap on the response length. Default 350 tokens — fits in a
   *  3-paragraph Telegram reply. */
  maxTokens?: number;
}

export type OrchestratorAnswerOutcome =
  | { status: "ok"; text: string; costUsd: number; durationMs: number }
  | { status: "disabled"; reason: string }
  | { status: "budget_exceeded"; spentUsd: number; capUsd: number }
  | { status: "failed"; reason: string }
  | { status: "empty_response" };

export class OrchestratorChat {
  private readonly db: ForemanDb;
  private readonly config: LlmConfig;
  private readonly secretStore: SecretStore;
  private readonly registry: RegistryService;
  private readonly bus: EventBus<ForemanEventMap> | undefined;

  constructor(opts: OrchestratorChatOptions) {
    this.db = opts.db;
    this.config = opts.config;
    this.secretStore = opts.secretStore;
    this.registry = opts.registry;
    this.bus = opts.bus;
  }

  /** True when both `enabled` AND `features.orchestrator_chat` are on. */
  isEnabled(): boolean {
    return isFeatureEnabled(this.config, "orchestrator_chat");
  }

  async answer(
    input: OrchestratorAnswerInput,
  ): Promise<OrchestratorAnswerOutcome> {
    if (!this.isEnabled()) {
      return {
        status: "disabled",
        reason:
          "Foreman LLM orchestrator chat is off. Turn it on with `foreman llm enable orchestrator_chat` on the host.",
      };
    }
    try {
      assertBudget(this.db, this.config);
    } catch (err) {
      if (err instanceof LlmBudgetExceededError) {
        return {
          status: "budget_exceeded",
          spentUsd: err.spentUsd,
          capUsd: err.capUsd,
        };
      }
      if (err instanceof LlmDisabledError) {
        return { status: "disabled", reason: err.message };
      }
      throw err;
    }

    const snapshot: OrchestratorSnapshot = buildOrchestratorSnapshot(
      this.db,
      this.registry,
      input.focusAgentId ? { agentId: input.focusAgentId } : {},
    );
    const prompt = buildOrchestratorPrompt({
      snapshot,
      question: input.question,
      focusAgentId: input.focusAgentId,
    });

    let client;
    try {
      client = buildLlmClient(this.config, this.secretStore);
    } catch (err) {
      return {
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    try {
      const resp = await client.call(prompt, {
        feature: "orchestrator_chat",
        maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: DEFAULT_TEMPERATURE,
      });
      recordUsageAndCheckBudget(
        this.db,
        this.config,
        {
          provider: client.providerId,
          model: client.model,
          feature: "orchestrator_chat",
          inputTokens: resp.inputTokens,
          outputTokens: resp.outputTokens,
          costUsd: resp.costUsd,
          durationMs: resp.durationMs,
          cacheHit: resp.cacheHit,
        },
        this.bus,
      );
      const text = resp.text.trim();
      if (text.length === 0) {
        return { status: "empty_response" };
      }
      return {
        status: "ok",
        text,
        costUsd: resp.costUsd,
        durationMs: resp.durationMs,
      };
    } catch (err) {
      if (err instanceof LlmBudgetExceededError) {
        return {
          status: "budget_exceeded",
          spentUsd: err.spentUsd,
          capUsd: err.capUsd,
        };
      }
      return {
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
