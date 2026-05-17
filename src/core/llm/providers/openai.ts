import {
  LlmProviderError,
  type LlmCallOptions,
  type LlmClient,
  type LlmResponse,
} from '../client.js'

// =============================================================================
// OpenAI Chat Completions client (#294 / v0.1.0)
// =============================================================================
//
// Mirrors the AnthropicLlmClient shape so the factory (#296) can swap providers
// without callers branching. Talks to /v1/chat/completions with a single
// user message — verification + smart-report are one-shot prompts, no streaming
// / tool-use needed.

export interface OpenAIFetch {
  (url: string, init: RequestInit): Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
    text(): Promise<string>
  }>
}

export interface OpenAIClientOptions {
  apiKey: string
  model: string
  fetchImpl?: OpenAIFetch
  /** Override the API base. OPENAI_API_BASE env wins if set; explicit opt wins
   *  over env. Useful for proxies, Azure OpenAI, and tests. */
  apiBase?: string
  /** Per-call timeout default; opts.timeoutMs wins. */
  defaultTimeoutMs?: number
  /** Optional organisation header (rarely needed; mostly for shared org keys). */
  organisation?: string
}

interface OpenAICompletionResponse {
  choices?: {
    message?: { role: string; content: string | null }
    finish_reason?: string
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
  error?: { type?: string; message?: string; code?: string }
}

// USD per million tokens. Snapshot late 2025 / early 2026. Refresh quarterly.
// Unknown models fall back to gpt-4o-mini pricing as a conservative floor —
// we'd rather over-account than silently under-bill a future release.
const PRICING_USD_PER_MTOK: Record<
  string,
  { input: number; output: number }
> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'o1': { input: 15, output: 60 },
  'o1-mini': { input: 3, output: 12 },
  'o3': { input: 2, output: 8 },
  'o3-mini': { input: 1.1, output: 4.4 },
}

const DEFAULT_API_BASE = 'https://api.openai.com'
const DEFAULT_TIMEOUT_MS = 5_000

export class OpenAILlmClient implements LlmClient {
  readonly providerId = 'openai' as const
  readonly model: string
  private readonly apiKey: string
  private readonly fetchImpl: OpenAIFetch
  private readonly apiBase: string
  private readonly defaultTimeoutMs: number
  private readonly organisation?: string

  constructor(opts: OpenAIClientOptions) {
    this.apiKey = opts.apiKey
    this.model = opts.model
    this.fetchImpl =
      opts.fetchImpl ?? ((u, init) => fetch(u, init) as never)
    this.apiBase =
      opts.apiBase ?? process.env.OPENAI_API_BASE ?? DEFAULT_API_BASE
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.organisation = opts.organisation
  }

  async ping(): Promise<LlmResponse> {
    return this.call('Say "pong" in one word.', {
      feature: 'test',
      maxTokens: 8,
      temperature: 0,
    })
  }

  async call(prompt: string, opts: LlmCallOptions): Promise<LlmResponse> {
    const url = `${this.apiBase}/v1/chat/completions`
    const body = JSON.stringify({
      model: this.model,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0,
      messages: [{ role: 'user', content: prompt }],
    })

    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? this.defaultTimeoutMs,
    )
    const t0 = Date.now()
    let res
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      }
      if (this.organisation) headers['openai-organization'] = this.organisation
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      })
    } catch (err) {
      throw new LlmProviderError(
        `OpenAI fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        'openai',
      )
    } finally {
      clearTimeout(timer)
    }
    const durationMs = Date.now() - t0

    if (!res.ok) {
      const text = await res.text().catch(() => '<no body>')
      throw new LlmProviderError(
        `OpenAI HTTP ${res.status}: ${text}`,
        'openai',
      )
    }

    const parsed = (await res.json()) as OpenAICompletionResponse
    if (parsed.error) {
      throw new LlmProviderError(
        `OpenAI error: ${parsed.error.message ?? 'unknown'}`,
        'openai',
      )
    }

    const text = parsed.choices?.[0]?.message?.content ?? ''
    const inputTokens = parsed.usage?.prompt_tokens ?? 0
    const outputTokens = parsed.usage?.completion_tokens ?? 0
    return {
      text,
      inputTokens,
      outputTokens,
      costUsd: calculateCostUsd(this.model, inputTokens, outputTokens),
      durationMs,
      cacheHit: false,
    }
  }
}

export function calculateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = PRICING_USD_PER_MTOK[model]
  if (!pricing) {
    const fallback = PRICING_USD_PER_MTOK['gpt-4o-mini']!
    return (
      (inputTokens * fallback.input + outputTokens * fallback.output) /
      1_000_000
    )
  }
  return (
    (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
  )
}

export const _PRICING_USD_PER_MTOK = PRICING_USD_PER_MTOK
