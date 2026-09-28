import {
  LlmProviderError,
  type LlmCallOptions,
  type LlmClient,
  type LlmResponse,
} from "../client.js";
import { costUsd, lookupPrice, type TokenPrice } from "../pricing.js";
import { _PRICING_USD_PER_MTOK as ANTHROPIC_PRICES } from "./anthropic.js";
import { _PRICING_USD_PER_MTOK as GEMINI_PRICES } from "./gemini.js";
import {
  _PRICING_USD_PER_MTOK as OPENAI_PRICES,
  type OpenAIFetch,
} from "./openai.js";

// =============================================================================
// OpenAI Chat Completions client for self-hosted brains
// =============================================================================
//
// One client for both `ollama` (Ollama serves the same wire format at
// <host>/v1) and `openai_compatible` (DeepSeek, OpenRouter, Groq, vLLM, …).
// `baseUrl` already carries the version path (`…/v1`); the factory
// normalises it. Redirects are refused so neither the prompt nor the API key
// is ever sent anywhere but the configured endpoint.

export type OpenAICompatibleProviderId = "ollama" | "openai_compatible";

export interface OpenAICompatibleClientOptions {
  providerId: OpenAICompatibleProviderId;
  /** Validated base URL including the version path, no trailing slash. */
  baseUrl: string;
  model: string;
  /** Sent as a Bearer token when set; keyless otherwise (local Ollama). */
  apiKey?: string | null;
  fetchImpl?: OpenAIFetch;
  defaultTimeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ERROR_BODY_CHARS = 500;

// There is no price table for an OpenAI-compatible endpoint: it can serve any
// model at any price. Every call is billed at the most expensive current
// price Foreman knows (the ceiling unknown OpenAI / Anthropic models get), or
// at a priced model's own rate when a vendor-prefixed id such as
// `openai/o1-pro` names one that costs more — so the budget is never
// under-counted. Ollama runs on hardware the user owns and is free.
const CEILING_PRICE: TokenPrice = { input: 10, output: 50 };
const CEILING_PRO_PRICE: TokenPrice = { input: 30, output: 180 };
const KNOWN_PRICE_TABLES: readonly Readonly<Record<string, TokenPrice>>[] = [
  OPENAI_PRICES,
  ANTHROPIC_PRICES,
  GEMINI_PRICES,
];

export class OpenAICompatibleLlmClient implements LlmClient {
  readonly providerId: OpenAICompatibleProviderId;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly fetchImpl: OpenAIFetch;
  private readonly defaultTimeoutMs: number;

  constructor(opts: OpenAICompatibleClientOptions) {
    this.providerId = opts.providerId;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.apiKey = opts.apiKey ? opts.apiKey : null;
    this.fetchImpl = opts.fetchImpl ?? ((u, init) => fetch(u, init) as never);
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
    const body = JSON.stringify({
      model: this.model,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const label = this.label();
    const controller = new AbortController();
    // The timer covers the body read too, so a server that sends headers and
    // then stalls can't hang a verification past its deadline.
    const timer = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? this.defaultTimeoutMs,
    );
    const t0 = Date.now();
    let status: number;
    let ok: boolean;
    let text: string;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: controller.signal,
      });
      status = res.status;
      ok = res.ok;
      text = await res.text();
    } catch (err) {
      const reason = controller.signal.aborted
        ? `timed out after ${opts.timeoutMs ?? this.defaultTimeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      throw new LlmProviderError(`${label} fetch failed: ${reason}`, this.providerId);
    } finally {
      clearTimeout(timer);
    }
    const durationMs = Date.now() - t0;

    if (!ok) {
      throw new LlmProviderError(
        `${label} HTTP ${status}: ${text.slice(0, MAX_ERROR_BODY_CHARS) || "<no body>"}`,
        this.providerId,
      );
    }

    let parsed: ChatCompletionResponse;
    try {
      parsed = JSON.parse(text) as ChatCompletionResponse;
    } catch {
      throw new LlmProviderError(
        `${label} returned a response that is not JSON`,
        this.providerId,
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new LlmProviderError(
        `${label} returned an unexpected response`,
        this.providerId,
      );
    }
    if (parsed.error) {
      const message =
        typeof parsed.error === "string"
          ? parsed.error
          : (parsed.error.message ?? "unknown");
      throw new LlmProviderError(`${label} error: ${message}`, this.providerId);
    }

    const content = parsed.choices?.[0]?.message?.content;
    const reply = typeof content === "string" ? content : "";
    const usage = parsed.usage;
    const inputTokens = tokenCount(usage?.prompt_tokens);
    const outputTokens = tokenCount(usage?.completion_tokens);
    return {
      text: reply,
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      costUsd:
        this.providerId === "ollama"
          ? 0
          : calculateCostUsd(
              this.model,
              // No usage block from a paid endpoint: bill the worst case (a
              // token per prompt character, the full output cap) rather
              // than nothing.
              inputTokens ?? prompt.length,
              outputTokens ?? opts.maxTokens,
            ),
      durationMs,
      cacheHit: false,
    };
  }

  private label(): string {
    return this.providerId === "ollama" ? "Ollama" : "OpenAI-compatible endpoint";
  }
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Cost of an `openai_compatible` call: the ceiling price, or a known
 *  model's own price when that is higher. */
export function calculateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const bare = model.slice(model.lastIndexOf("/") + 1);
  const ceiling = /-pro\b/i.test(bare) ? CEILING_PRO_PRICE : CEILING_PRICE;
  let cost = costUsd(ceiling, inputTokens, outputTokens);
  for (const table of KNOWN_PRICE_TABLES) {
    const known = lookupPrice(table, bare);
    if (known) cost = Math.max(cost, costUsd(known, inputTokens, outputTokens));
  }
  return cost;
}
