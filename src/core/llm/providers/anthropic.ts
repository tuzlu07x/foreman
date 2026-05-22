import {
  LlmProviderError,
  type LlmCallOptions,
  type LlmClient,
  type LlmResponse,
} from "../client.js";

// =============================================================================
// Anthropic Messages API client (#230 / C7)
// =============================================================================
//
// Minimal impl: one prompt → one assistant message back. Uses native fetch
// (Node 20+) with an injectable transport for tests. Cost is calculated from
// a hardcoded pricing table — these numbers must be refreshed when Anthropic
// changes pricing (see PRICING comment below).

export interface AnthropicFetch {
  (
    url: string,
    init: RequestInit,
  ): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

export interface AnthropicClientOptions {
  apiKey: string;
  model: string;
  fetchImpl?: AnthropicFetch;
  /** Override the API base. Useful for proxies / tests. */
  apiBase?: string;
  /** Default per-call timeout in ms; per-call opts.timeoutMs wins. */
  defaultTimeoutMs?: number;
}

interface AnthropicMessageResponse {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type: string; message: string };
}

const PRICING_USD_PER_MTOK: Record<string, { input: number; output: number }> =
  {
    "claude-opus-4-7": { input: 15, output: 75 },
    "claude-sonnet-4-6": { input: 3, output: 15 },
    "claude-haiku-4-5": { input: 1, output: 5 },
    "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  };

const DEFAULT_API_BASE = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_MS = 60_000;
const ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicLlmClient implements LlmClient {
  readonly providerId = "anthropic" as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: AnthropicFetch;
  private readonly apiBase: string;
  private readonly defaultTimeoutMs: number;

  constructor(opts: AnthropicClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? ((u, init) => fetch(u, init) as never);
    this.apiBase = opts.apiBase ?? DEFAULT_API_BASE;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async ping(): Promise<LlmResponse> {
    return this.call('Say "pong" in one word.', {
      feature: "test",
      maxTokens: 8,
      temperature: 0,
    });
  }

  async call(prompt: string, opts: LlmCallOptions): Promise<LlmResponse> {
    const url = `${this.apiBase}/v1/messages`;
    const body = JSON.stringify({
      model: this.model,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0,
      messages: [{ role: "user", content: prompt }],
    });

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? this.defaultTimeoutMs,
    );
    const t0 = Date.now();
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      throw new LlmProviderError(
        `Anthropic fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        "anthropic",
      );
    } finally {
      clearTimeout(timer);
    }
    const durationMs = Date.now() - t0;

    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      throw new LlmProviderError(
        `Anthropic HTTP ${res.status}: ${text}`,
        "anthropic",
      );
    }

    const parsed = (await res.json()) as AnthropicMessageResponse;
    if (parsed.error) {
      throw new LlmProviderError(
        `Anthropic error: ${parsed.error.message}`,
        "anthropic",
      );
    }

    const text = parsed.content?.find((c) => c.type === "text")?.text ?? "";
    const inputTokens = parsed.usage?.input_tokens ?? 0;
    const outputTokens = parsed.usage?.output_tokens ?? 0;
    return {
      text,
      inputTokens,
      outputTokens,
      costUsd: calculateCostUsd(this.model, inputTokens, outputTokens),
      durationMs,
      cacheHit: false,
    };
  }
}

// Exported for budget tests + future cost-projection commands.
export function calculateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = PRICING_USD_PER_MTOK[model];
  if (!pricing) {
    const fallback = PRICING_USD_PER_MTOK["claude-haiku-4-5"]!;
    return (
      (inputTokens * fallback.input + outputTokens * fallback.output) /
      1_000_000
    );
  }
  return (
    (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
  );
}

export const _PRICING_USD_PER_MTOK = PRICING_USD_PER_MTOK;
