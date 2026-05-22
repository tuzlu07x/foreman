import {
  LlmProviderError,
  type LlmCallOptions,
  type LlmClient,
  type LlmResponse,
} from "../client.js";

export interface OpenAIFetch {
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

type OpenAIHttpResponse = Awaited<ReturnType<OpenAIFetch>>;

export interface OpenAIClientOptions {
  apiKey: string;
  model: string;
  fetchImpl?: OpenAIFetch;
  apiBase?: string;
  defaultTimeoutMs?: number;
  organisation?: string;
}

interface OpenAICompletionResponse {
  choices?: {
    message?: { role: string; content: string | null };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: OpenAIErrorBody;
}

export interface OpenAIErrorBody {
  message?: string;
  type?: string;
  param?: string;
  code?: string;
}

interface ModelQuirks {
  tokenField: "max_tokens" | "max_completion_tokens";
  sendsTemperature: boolean;
}

const PRICING_USD_PER_MTOK: Record<string, { input: number; output: number }> =
  {
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    "gpt-4o": { input: 2.5, output: 10 },
    "gpt-4.1": { input: 2, output: 8 },
    "gpt-4.1-mini": { input: 0.4, output: 1.6 },
    "gpt-4.1-nano": { input: 0.1, output: 0.4 },
    "gpt-5": { input: 1.25, output: 10 },
    "gpt-5-mini": { input: 0.25, output: 2 },
    "gpt-5-nano": { input: 0.05, output: 0.4 },
    o1: { input: 15, output: 60 },
    "o1-mini": { input: 3, output: 12 },
    o3: { input: 2, output: 8 },
    "o3-mini": { input: 1.1, output: 4.4 },
  };

const DEFAULT_API_BASE = "https://api.openai.com";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ADAPT_RETRIES = 3;

export class OpenAILlmClient implements LlmClient {
  readonly providerId = "openai" as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: OpenAIFetch;
  private readonly apiBase: string;
  private readonly defaultTimeoutMs: number;
  private readonly organisation?: string;

  private quirks: ModelQuirks = {
    tokenField: "max_tokens",
    sendsTemperature: true,
  };

  constructor(opts: OpenAIClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? ((u, init) => fetch(u, init) as never);
    this.apiBase =
      opts.apiBase ?? process.env.OPENAI_API_BASE ?? DEFAULT_API_BASE;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.organisation = opts.organisation;
  }

  async ping(): Promise<LlmResponse> {
    return this.call('Say "pong" in one word.', {
      feature: "test",
      maxTokens: 8,
      temperature: 0,
    });
  }

  async call(prompt: string, opts: LlmCallOptions): Promise<LlmResponse> {
    const url = `${this.apiBase}/v1/chat/completions`;

    for (let attempt = 0; ; attempt++) {
      const { res, durationMs } = await this.post(url, prompt, opts);

      if (res.ok) {
        return await parseSuccess(res, this.model, durationMs);
      }

      const text = await res.text().catch(() => "<no body>");
      if (
        res.status === 400 &&
        attempt < MAX_ADAPT_RETRIES &&
        this.adaptQuirks(text)
      ) {
        continue;
      }
      throw new LlmProviderError(
        `OpenAI HTTP ${res.status}: ${text}`,
        "openai",
      );
    }
  }

  private async post(
    url: string,
    prompt: string,
    opts: LlmCallOptions,
  ): Promise<{ res: OpenAIHttpResponse; durationMs: number }> {
    const payload: Record<string, unknown> = {
      model: this.model,
      [this.quirks.tokenField]: opts.maxTokens,
      messages: [{ role: "user", content: prompt }],
    };
    if (this.quirks.sendsTemperature) {
      payload.temperature = opts.temperature ?? 0;
    }
    const body = JSON.stringify(payload);

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? this.defaultTimeoutMs,
    );
    const t0 = Date.now();
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      };
      if (this.organisation) headers["openai-organization"] = this.organisation;
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      return { res, durationMs: Date.now() - t0 };
    } catch (err) {
      throw new LlmProviderError(
        `OpenAI fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        "openai",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private adaptQuirks(bodyText: string): boolean {
    const err = parseOpenAIError(bodyText);
    if (!err) return false;
    const param = (err.param ?? "").toLowerCase();
    const message = (err.message ?? "").toLowerCase();

    if (
      this.quirks.tokenField === "max_tokens" &&
      (param === "max_tokens" || message.includes("max_tokens")) &&
      message.includes("max_completion_tokens")
    ) {
      this.quirks.tokenField = "max_completion_tokens";
      return true;
    }

    if (this.quirks.sendsTemperature && param === "temperature") {
      this.quirks.sendsTemperature = false;
      return true;
    }

    return false;
  }
}

async function parseSuccess(
  res: OpenAIHttpResponse,
  model: string,
  durationMs: number,
): Promise<LlmResponse> {
  const parsed = (await res.json()) as OpenAICompletionResponse;
  if (parsed.error) {
    throw new LlmProviderError(
      `OpenAI error: ${parsed.error.message ?? "unknown"}`,
      "openai",
    );
  }
  const text = parsed.choices?.[0]?.message?.content ?? "";
  const inputTokens = parsed.usage?.prompt_tokens ?? 0;
  const outputTokens = parsed.usage?.completion_tokens ?? 0;
  return {
    text,
    inputTokens,
    outputTokens,
    costUsd: calculateCostUsd(model, inputTokens, outputTokens),
    durationMs,
    cacheHit: false,
  };
}

export function parseOpenAIError(bodyText: string): OpenAIErrorBody | null {
  try {
    const parsed = JSON.parse(bodyText) as { error?: OpenAIErrorBody };
    return parsed && typeof parsed === "object" ? (parsed.error ?? null) : null;
  } catch {
    return null;
  }
}

export function calculateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = PRICING_USD_PER_MTOK[model];
  if (!pricing) {
    const fallback = PRICING_USD_PER_MTOK["gpt-4o-mini"]!;
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
