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
  assignableTargets,
  buildOrchestratorPrompt,
  buildOrchestratorSnapshot,
  parseAssignProposals,
  type AssignProposal,
  type ChatTurn,
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

/** Room to summarise a report the user asks for. */
const DEFAULT_MAX_TOKENS = 700;
/** Room for a short plan and its ASSIGN lines. */
const PLAN_MAX_TOKENS = 900;
const DEFAULT_TEMPERATURE = 0.3;
/** A conversation remembers its last turns for a while (2.3.1): "do it"
 *  after "here's how I'd split it" means that plan. */
const MEMORY_TURNS = 6;
const MEMORY_TTL_MS = 30 * 60 * 1000;
const MEMORY_CONVERSATIONS = 50;

export interface OrchestratorChatOptions {
  db: ForemanDb;
  config: LlmConfig;
  secretStore: SecretStore;
  registry: RegistryService;
  bus?: EventBus<ForemanEventMap>;
  /** org.yaml: the team the chat can hand work to. */
  orgConfigPath?: string;
  /** Override for tests. */
  now?: () => number;
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
  /** Who is talking, where (`telegram:<user>`): the chat remembers the
   *  last turns per conversation. None: no memory. */
  conversation?: string;
  /** The owner asks, and can approve a plan: the reply may propose
   *  hand-offs (`proposals`). */
  canPropose?: boolean;
}

export type OrchestratorAnswerOutcome =
  | { status: "ok"; text: string; costUsd: number; durationMs: number; proposals?: AssignProposal[] }
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
  private readonly orgConfigPath: string | undefined;
  private readonly now: () => number;
  private readonly memory = new Map<string, { turns: ChatTurn[]; at: number }>();

  constructor(opts: OrchestratorChatOptions) {
    this.db = opts.db;
    this.config = opts.config;
    this.secretStore = opts.secretStore;
    this.registry = opts.registry;
    this.bus = opts.bus;
    this.orgConfigPath = opts.orgConfigPath;
    this.now = opts.now ?? Date.now;
  }

  /** The conversation's remembered turns, oldest first (expired: none). */
  history(conversation: string | undefined): ChatTurn[] {
    if (!conversation) return [];
    const kept = this.memory.get(conversation);
    if (!kept || this.now() - kept.at > MEMORY_TTL_MS) {
      this.memory.delete(conversation);
      return [];
    }
    return [...kept.turns];
  }

  /** Remember a turn; the oldest conversations go first past the cap. */
  remember(conversation: string | undefined, ...turns: ChatTurn[]): void {
    if (!conversation) return;
    const turnsNow = [...this.history(conversation), ...turns].slice(-MEMORY_TURNS);
    this.memory.delete(conversation);
    this.memory.set(conversation, { turns: turnsNow, at: this.now() });
    while (this.memory.size > MEMORY_CONVERSATIONS) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
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

    const snapshot: OrchestratorSnapshot = buildOrchestratorSnapshot(this.db, this.registry, {
      ...(input.focusAgentId ? { agentId: input.focusAgentId } : {}),
      ...(this.orgConfigPath ? { orgConfigPath: this.orgConfigPath } : {}),
    });
    const allowed = input.canPropose ? assignableTargets(snapshot.team) : new Set<string>();
    const canPropose = allowed.size > 0;
    const prompt = buildOrchestratorPrompt({
      snapshot,
      question: input.question,
      focusAgentId: input.focusAgentId,
      history: this.history(input.conversation),
      canPropose,
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
        maxTokens: input.maxTokens ?? (canPropose ? PLAN_MAX_TOKENS : DEFAULT_MAX_TOKENS),
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
      // Plans only from the owner's own turn; any ASSIGN line is taken out.
      const { text, proposals } = parseAssignProposals(resp.text.trim(), allowed);
      if (text.length === 0 && proposals.length === 0) {
        return { status: "empty_response" };
      }
      this.remember(
        input.conversation,
        { role: "user", text: input.question },
        {
          role: "foreman",
          text: proposals.length > 0 ? `${text}\n(proposed: ${proposals.map((p) => `${p.target}: ${p.task}`).join("; ")})` : text,
        },
      );
      return {
        status: "ok",
        text,
        costUsd: resp.costUsd,
        durationMs: resp.durationMs,
        ...(proposals.length > 0 ? { proposals } : {}),
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
