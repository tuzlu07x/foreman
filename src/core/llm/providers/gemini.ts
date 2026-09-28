import {
  LlmProviderError,
  type LlmCallOptions,
  type LlmClient,
  type LlmResponse,
} from "../client.js";
import { costUsd, lookupPrice, type TokenPrice } from "../pricing.js";

// =============================================================================
// Google Gemini client (#295 / v0.1.0)
// =============================================================================
//
// Talks to generativelanguage.googleapis.com /v1beta/models/{model}:generateContent
// Same shape as Anthropic + OpenAI clients so the factory (#296) can dispatch
// without callers branching. Auth via x-goog-api-key header (we avoid the
// ?key= query param so the key never lands in proxy logs).

export interface GeminiFetch {
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

export interface GeminiClientOptions {
  apiKey: string;
  model: string;
  fetchImpl?: GeminiFetch;
  /** Override the API base. GEMINI_API_BASE env wins if set; explicit opt
   *  wins over env. */
  apiBase?: string;
  defaultTimeoutMs?: number;
}

interface GeminiContentPart {
  text?: string;
}
interface GeminiCandidate {
  content?: { parts?: GeminiContentPart[]; role?: string };
  finishReason?: string;
}
interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsage;
  error?: { code?: number; message?: string; status?: string };
}

// Gemini API paid-tier list prices for prompts up to 200k tokens, USD per
// million tokens (https://ai.google.dev/gemini-api/docs/pricing, 2026-09-28).
// Gemini 3.6-3.8 Flash cost $0.75 / $3.75 until 2026-12-31 and twice that
// from 2027; the table uses the regular price so a budget never runs over.
const PRICING_USD_PER_MTOK: Record<string, TokenPrice> = {
  "gemini-3.8-flash": { input: 1.5, output: 7.5 },
  "gemini-3.7-flash": { input: 1.5, output: 7.5 },
  "gemini-3.6-flash": { input: 1.5, output: 7.5 },
  "gemini-3.5-flash": { input: 1.5, output: 9 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  "gemini-3.1-pro": { input: 2, output: 12 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.0-flash-lite": { input: 0.075, output: 0.3 },
  "gemini-2.0-pro": { input: 1.25, output: 5 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-1.5-flash-8b": { input: 0.0375, output: 0.15 },
  "gemini-1.5-pro": { input: 1.25, output: 5 },
};

// A model missing from the table is billed like the most expensive current
// one (Gemini 3.1 Pro), so the budget can't be outrun by a model we haven't
// priced.
const UNKNOWN_MODEL_PRICE: TokenPrice = { input: 2, output: 12 };

const DEFAULT_API_BASE = "https://generativelanguage.googleapis.com";
const DEFAULT_TIMEOUT_MS = 60_000;

export class GeminiLlmClient implements LlmClient {
  readonly providerId = "gemini" as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: GeminiFetch;
  private readonly apiBase: string;
  private readonly defaultTimeoutMs: number;

  constructor(opts: GeminiClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? ((u, init) => fetch(u, init) as never);
    this.apiBase =
      opts.apiBase ?? process.env.GEMINI_API_BASE ?? DEFAULT_API_BASE;
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
    const url = `${this.apiBase}/v1beta/models/${this.model}:generateContent`;
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: opts.maxTokens,
        temperature: opts.temperature ?? 0,
      },
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
          "x-goog-api-key": this.apiKey,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      throw new LlmProviderError(
        `Gemini fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        "gemini",
      );
    } finally {
      clearTimeout(timer);
    }
    const durationMs = Date.now() - t0;

    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      throw new LlmProviderError(
        `Gemini HTTP ${res.status}: ${text}`,
        "gemini",
      );
    }

    const parsed = (await res.json()) as GeminiResponse;
    if (parsed.error) {
      throw new LlmProviderError(
        `Gemini error: ${parsed.error.message ?? "unknown"}`,
        "gemini",
      );
    }

    const text =
      parsed.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? "")
        .join("") ?? "";
    const inputTokens = parsed.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = parsed.usageMetadata?.candidatesTokenCount ?? 0;
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

export function calculateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = lookupPrice(PRICING_USD_PER_MTOK, model) ?? UNKNOWN_MODEL_PRICE;
  return costUsd(price, inputTokens, outputTokens);
}

export const _PRICING_USD_PER_MTOK = PRICING_USD_PER_MTOK;
