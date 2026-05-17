import type { ForemanDb } from '../../db/client.js'
import {
  bus as defaultBus,
  type EventBus,
  type ForemanEventMap,
} from '../event-bus.js'
import { bucketFor } from '../risk-scorer.js'
import type { LlmVerification, RiskAssessment } from '../risk-rules/types.js'
import { assertBudget, recordUsageAndCheckBudget } from './budget.js'
import { LlmBudgetExceededError, LlmProviderError, type LlmClient } from './client.js'
import { LruCache } from './cache.js'
import { isFeatureEnabled, type LlmConfig } from './config.js'
import { parseVerification, VerificationParseError } from './parse-verification.js'
import {
  buildVerificationPrompt,
  makeCacheKey,
  type PromptContext,
} from './prompts.js'

// =============================================================================
// LlmVerifier (#231 / C8)
// =============================================================================
//
// Owns the gating logic so callers (mediator) don't have to remember every
// short-circuit: feature flag, score threshold, budget, cache, then call.
// Always returns SOMETHING (never null) so the assessment can carry a
// `skipped` reason — that's better UX than a missing field.

export interface LlmVerifierOptions {
  db: ForemanDb
  config: LlmConfig
  client: LlmClient
  /** Only verify when heuristic score ≥ this. Default 30 (medium bucket floor). */
  verificationThreshold?: number
  /** LRU capacity + TTL. */
  cache?: LruCache<VerificationCacheValue>
  /** Injectable clock so tests can advance time without sleep. */
  now?: () => number
  /** Optional bus override; defaults to the global one. */
  bus?: EventBus<ForemanEventMap>
}

interface VerificationCacheValue {
  core: ReturnType<typeof parseVerification>
  costUsd: number
  latencyMs: number
  provider: string
  model: string
}

const DEFAULT_THRESHOLD = 30
const DEFAULT_MAX_TOKENS = 400
const DEFAULT_TEMPERATURE = 0

export class LlmVerifier {
  private readonly db: ForemanDb
  private readonly config: LlmConfig
  private readonly client: LlmClient
  private readonly threshold: number
  private readonly cache: LruCache<VerificationCacheValue>
  private readonly now: () => number
  private readonly bus: EventBus<ForemanEventMap>

  constructor(opts: LlmVerifierOptions) {
    this.db = opts.db
    this.config = opts.config
    this.client = opts.client
    this.threshold = opts.verificationThreshold ?? DEFAULT_THRESHOLD
    this.cache = opts.cache ?? new LruCache<VerificationCacheValue>()
    this.now = opts.now ?? (() => Date.now())
    this.bus = opts.bus ?? defaultBus
  }

  /** Verify the heuristic assessment. Always returns an LlmVerification —
   *  `skipped` carries the reason when we short-circuited. */
  async verify(
    ctx: PromptContext,
    requestId?: string,
  ): Promise<LlmVerification> {
    // Gate 1: feature disabled
    if (!isFeatureEnabled(this.config, 'verification')) {
      return this.skippedShell('feature_disabled', ctx)
    }

    // Gate 2: heuristic score below the trigger threshold — no point asking
    // the LLM about a benign call.
    if (ctx.totalScore < this.threshold) {
      return this.skippedShell('below_threshold', ctx)
    }

    // Gate 3: budget. Returns skipped instead of throwing so the mediator
    // gets a clean fallback shape.
    try {
      assertBudget(this.db, this.config)
    } catch (err) {
      if (err instanceof LlmBudgetExceededError) {
        return this.skippedShell('budget_exhausted', ctx)
      }
      throw err
    }

    // Gate 4: cache. Identical pattern → reuse the prior verdict.
    const key = makeCacheKey(ctx)
    const cached = this.cache.get(key)
    if (cached) {
      return this.fromCache(cached)
    }

    // Call the model.
    const prompt = buildVerificationPrompt(ctx)
    try {
      const t0 = this.now()
      const resp = await this.client.call(prompt, {
        feature: 'verification',
        maxTokens: DEFAULT_MAX_TOKENS,
        temperature: DEFAULT_TEMPERATURE,
        requestId,
      })
      const latencyMs = this.now() - t0
      const core = parseVerification(resp.text)

      recordUsageAndCheckBudget(
        this.db,
        this.config,
        {
          provider: this.client.providerId,
          model: this.client.model,
          feature: 'verification',
          inputTokens: resp.inputTokens,
          outputTokens: resp.outputTokens,
          costUsd: resp.costUsd,
          requestId,
          durationMs: resp.durationMs,
        },
        this.bus,
        this.now(),
      )

      const value: VerificationCacheValue = {
        core,
        costUsd: resp.costUsd,
        latencyMs,
        provider: this.client.providerId,
        model: this.client.model,
      }
      this.cache.set(key, value)
      return {
        ...core,
        provider: this.client.providerId,
        model: this.client.model,
        costUsd: resp.costUsd,
        latencyMs,
        fromCache: false,
      }
    } catch (err) {
      if (
        err instanceof VerificationParseError ||
        err instanceof LlmProviderError
      ) {
        return this.skippedShell('llm_error', ctx)
      }
      throw err
    }
  }

  // ============================================================================
  // Internals
  // ============================================================================

  // When skipped, return a placeholder that downstream renderers can still
  // display without crashing. The skipped reason is the signal that this is
  // not real model output.
  private skippedShell(
    reason: LlmVerification['skipped'],
    ctx: PromptContext,
  ): LlmVerification {
    return {
      is_real_threat: ctx.totalScore >= this.threshold,
      threat_type: 'false_positive',
      confidence: 0,
      explanation_short: `LLM verification skipped: ${reason}`,
      explanation_long: `Heuristic flagged this call but the LLM was not consulted (${reason}). Decide using the factor list.`,
      recommended_action: 'ask',
      additional_risk_score: 0,
      user_should_check: [],
      provider: this.client.providerId,
      model: this.client.model,
      costUsd: 0,
      latencyMs: 0,
      fromCache: false,
      skipped: reason,
    }
  }

  private fromCache(value: VerificationCacheValue): LlmVerification {
    return {
      ...value.core,
      provider: value.provider,
      model: value.model,
      costUsd: 0, // cached responses don't cost money
      latencyMs: 0,
      fromCache: true,
    }
  }
}

// =============================================================================
// Combine — fold LLM verdict back into the heuristic assessment
// =============================================================================
//
// Only override the heuristic when confidence ≥ 0.7 — low-confidence LLM
// output is suggestive but not authoritative. additional_risk_score always
// adjusts the bucket math (small nudge, capped -30..+30).

const CONFIDENCE_OVERRIDE = 0.7

export function combineAssessment(
  heuristic: RiskAssessment,
  llm: LlmVerification | null,
): RiskAssessment {
  if (!llm || llm.skipped) {
    return llm
      ? { ...heuristic, llmVerification: llm }
      : heuristic
  }
  const adjustedScore = Math.max(
    0,
    Math.min(100, heuristic.totalScore + llm.additional_risk_score),
  )
  const recommendation =
    llm.confidence >= CONFIDENCE_OVERRIDE
      ? llm.recommended_action
      : heuristic.recommendation
  return {
    ...heuristic,
    totalScore: adjustedScore,
    bucket: bucketFor(adjustedScore),
    recommendation,
    llmVerification: llm,
  }
}
