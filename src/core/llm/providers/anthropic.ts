import {
  LlmProviderError,
  type LlmCallOptions,
  type LlmClient,
  type LlmResponse,
} from "../client.js";
import type { AccessTokenProvider } from "../oauth/token-refresh.js";

// =============================================================================
// Anthropic Messages API client (#230 / C7)
// =============================================================================
//
// Two modes from one class:
//
//   - API key  — `x-api-key` header, pay-per-token. The default; bit-identical
//                to the original implementation.
//   - OAuth    — `Authorization: Bearer …` against the same /v1/messages
//                endpoint, drawing from the user's Claude subscription. Adds
//                the Claude Code beta + identity headers Anthropic uses to
//                route OAuth traffic, and prepends a mandatory "You are Claude
//                Code…" system block. Without that prefix Anthropic
//                intermittently 500s OAuth requests (pi-ai / Hermes both
//                document this).
//
// Wire-shape facts mirrored from `@earendil-works/pi-ai`, the reference
// implementation Hermes + OpenClaw both ship in production. Bump
// CLAUDE_CODE_SPOOF_VERSION on each Foreman release; Anthropic rejects OAuth
// traffic when the spoofed user-agent is too far behind real Claude Code.

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
  /** API-key mode. Required unless `tokenProvider` is set. */
  apiKey?: string;
  /** OAuth mode — when set, each call resolves a fresh access token and the
   *  client sends the Claude Code beta headers + identity system block.
   *  `apiKey` is ignored in this mode. */
  tokenProvider?: AccessTokenProvider;
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
    "claude-opus-4-8": { input: 15, output: 75 },
    "claude-opus-4-7": { input: 15, output: 75 },
    "claude-sonnet-4-6": { input: 3, output: 15 },
    "claude-haiku-4-5": { input: 1, output: 5 },
    "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  };

const DEFAULT_API_BASE = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_MS = 60_000;
const ANTHROPIC_VERSION = "2023-06-01";

// Beta features required for OAuth traffic: `claude-code-20250219` enables the
// Claude Code request shape; `oauth-2025-04-20` enables Bearer-token auth.
const OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20";
// First `system` block — must be exactly this string for Anthropic to route
// OAuth traffic reliably. Real system prompts are appended as a second block.
const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";
// Spoofed CLI version. Bump on each Foreman release; Anthropic rejects OAuth
// traffic when this is too far behind the real Claude Code release.
const CLAUDE_CODE_SPOOF_VERSION = "2.1.145";

export class AnthropicLlmClient implements LlmClient {
  readonly providerId = "anthropic" as const;
  readonly model: string;
  private readonly apiKey?: string;
  private readonly tokenProvider?: AccessTokenProvider;
  private readonly fetchImpl: AnthropicFetch;
  private readonly apiBase: string;
  private readonly defaultTimeoutMs: number;

  constructor(opts: AnthropicClientOptions) {
    if (!opts.apiKey && !opts.tokenProvider) {
      throw new Error(
        "AnthropicLlmClient requires either `apiKey` or `tokenProvider`.",
      );
    }
    this.apiKey = opts.apiKey;
    this.tokenProvider = opts.tokenProvider;
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

    // Resolve auth + per-mode request shape. OAuth adds a Bearer token (no
    // x-api-key), the Claude Code beta headers, and the mandatory identity
    // system block; API-key mode keeps today's exact wire shape.
    const isOAuth = Boolean(this.tokenProvider);
    let headers: Record<string, string>;
    let bodyObj: Record<string, unknown> = {
      model: this.model,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0,
      messages: [{ role: "user", content: prompt }],
    };
    if (isOAuth) {
      const cred = await this.tokenProvider!();
      headers = {
        "content-type": "application/json",
        authorization: `Bearer ${cred.accessToken}`,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": OAUTH_BETA,
        "user-agent": `claude-cli/${CLAUDE_CODE_SPOOF_VERSION}`,
        "x-app": "cli",
      };
      bodyObj = {
        ...bodyObj,
        // Mandatory identity prefix — without it Anthropic intermittently
        // 500s OAuth traffic. Real system prompts would append as a second
        // block here once orchestrator_chat threads one through LlmCallOptions.
        system: [{ type: "text", text: CLAUDE_CODE_IDENTITY }],
      };
    } else {
      headers = {
        "content-type": "application/json",
        "x-api-key": this.apiKey!,
        "anthropic-version": ANTHROPIC_VERSION,
      };
    }

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
      // OAuth subscriptions don't bill per token — usage goes against the
      // user's Claude plan, not against an API budget. Match the Codex
      // client's convention so budget alerts only fire for API-key spend.
      costUsd: isOAuth
        ? 0
        : calculateCostUsd(this.model, inputTokens, outputTokens),
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
