import type { ProviderId } from './config.js'

// ============================================================================
// LLM client interface (#230 / C7)
// ============================================================================
//
// Every provider impl (Anthropic, OpenAI, Gemini, Ollama, OpenAI-compat)
// satisfies the same shape so callers (C8 verification, C9 smart report)
// don't branch on provider. The base contract is intentionally minimal —
// one prompt in, one response out, plus the metadata budget tracking needs.

export interface LlmCallOptions {
  /** Hard cap on output tokens. */
  maxTokens: number
  /** 0 = deterministic, 1 = creative. Default 0 for verification / report. */
  temperature?: number
  /** Identifier of the feature making the call — written to llm_usage.feature
   *  so the budget breakdown can attribute cost. */
  feature: string
  /** Optional link to a request row when the call is about a specific call. */
  requestId?: string
  /** Per-call timeout override; client may apply its own default otherwise. */
  timeoutMs?: number
}

export interface LlmResponse {
  text: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  durationMs: number
  /** Truthy when the response came from a local cache rather than the wire. */
  cacheHit: boolean
}

export interface LlmClient {
  /** Stable identifier for telemetry / budget rows. */
  providerId: ProviderId
  /** Model identifier the client was constructed with. */
  model: string
  /** Cheapest reachable round-trip — used by `foreman llm test`. */
  ping(): Promise<LlmResponse>
  /** Main entry — sends a prompt and returns the response with cost metadata. */
  call(prompt: string, opts: LlmCallOptions): Promise<LlmResponse>
}

export class LlmDisabledError extends Error {
  constructor() {
    super('LLM features are disabled — run `foreman llm enable` first')
    this.name = 'LlmDisabledError'
  }
}

export class LlmBudgetExceededError extends Error {
  constructor(public readonly spentUsd: number, public readonly capUsd: number) {
    super(
      `Monthly LLM budget exceeded: $${spentUsd.toFixed(2)} / $${capUsd.toFixed(2)}`,
    )
    this.name = 'LlmBudgetExceededError'
  }
}

export class LlmProviderError extends Error {
  constructor(message: string, public readonly providerId: ProviderId) {
    super(message)
    this.name = 'LlmProviderError'
  }
}
