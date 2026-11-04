import {
  LlmProviderError,
  type LlmCallOptions,
  type LlmClient,
  type LlmResponse,
} from "../client.js";
import { costUsd, lookupPrice, type TokenPrice } from "../pricing.js";

// =============================================================================
// Anthropic Messages API client (#230 / C7)
// =============================================================================
//
// API key only: `x-api-key` header, pay-per-token. A Claude plan connects
// through the real Claude Code binary instead (./claude-code.ts).

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

// Anthropic API list prices, USD per million tokens
// (https://platform.claude.com/docs/en/about-claude/pricing, 2026-09-28).
const PRICING_USD_PER_MTOK: Record<string, TokenPrice> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5-1": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4": { input: 3, output: 15 },
  // Up to 100K tokens per prompt; five times that above. Foreman's prompts
  // stay well under it.
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
};

/** Models that still take `temperature`; every newer one answers 400. */
const TAKES_TEMPERATURE = /^claude-(3-|haiku-4|sonnet-4|opus-4(-[0-6])?(-\d{8})?$)/;

/** What `model` accepts of the settings for a short, plain answer. Foreman's
 *  calls have no use for thinking, which would also eat into their small
 *  `max_tokens`. Fable and Opus 5.5 always think and refuse to be told not to. */
export function modelTuning(model: string, temperature: number): Record<string, unknown> {
  if (TAKES_TEMPERATURE.test(model)) return { temperature };
  if (model.startsWith("claude-sonnet-5-5")) return { thinking: { type: "between_tools" } };
  if (model.startsWith("claude-haiku-5") || /^claude-(sonnet|opus)-5(-\d{8})?$/.test(model)) {
    return { thinking: { type: "disabled" } };
  }
  return {};
}

// A model missing from the table is billed like the most expensive current
// one (Fable), so the budget can't be outrun by a model we haven't priced.
const UNKNOWN_MODEL_PRICE: TokenPrice = { input: 10, output: 50 };

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
      // Room for a model that always thinks first.
      maxTokens: 64,
      temperature: 0,
    });
  }

  async call(prompt: string, opts: LlmCallOptions): Promise<LlmResponse> {
    const url = `${this.apiBase}/v1/messages`;

    const headers = {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
    const bodyObj = {
      model: this.model,
      max_tokens: opts.maxTokens,
      ...modelTuning(this.model, opts.temperature ?? 0),
      messages: [{ role: "user", content: prompt }],
    };

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
        headers,
        body: JSON.stringify(bodyObj),
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
  const price = lookupPrice(PRICING_USD_PER_MTOK, model) ?? UNKNOWN_MODEL_PRICE;
  return costUsd(price, inputTokens, outputTokens);
}

export const _PRICING_USD_PER_MTOK = PRICING_USD_PER_MTOK;
