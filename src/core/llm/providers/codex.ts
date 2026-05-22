import { randomUUID } from "node:crypto";
import { arch, platform, release } from "node:os";
import {
  LlmProviderError,
  type LlmCallOptions,
  type LlmClient,
  type LlmResponse,
} from "../client.js";
import { CODEX_ORIGINATOR } from "../oauth/oauth-providers.js";
import type { AccessTokenProvider } from "../oauth/token-refresh.js";

// =============================================================================
// Codex (ChatGPT backend) LLM client — OAuth-only
// =============================================================================
//
// ChatGPT-account OAuth tokens do NOT work against api.openai.com — they're
// only valid for the Responses API behind `chatgpt.com/backend-api`. That's a
// different endpoint, a different request shape (`input`/`instructions` not
// `messages`), a different transport (SSE, always streaming, `store: false`
// mandatory), and a different cost model (your ChatGPT subscription, not your
// API budget). So this lives as a separate client rather than a switch inside
// OpenAILlmClient. ProviderId is still `'openai'` because — to the factory and
// budget tracker — it's the same logical provider; the OAuth variant is
// disambiguated by `auth_mode` upstream.
//
// Wire-shape facts mirrored from `@earendil-works/pi-ai` (the reference
// implementation that Hermes + OpenClaw both ship in production):
//
//   - URL                 https://chatgpt.com/backend-api/codex/responses
//   - Mandatory headers   Authorization Bearer, chatgpt-account-id (from JWT),
//                         originator=codex_cli_rs, OpenAI-Beta=responses=experimental
//   - Mandatory body      store: false  (else 400 "Store must be set to false")
//   - Body shape          Responses API: instructions + input[] message blocks
//   - Stream              text/event-stream — events keyed by `type`

export interface CodexFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  body: ReadableStream<Uint8Array> | null;
}

export interface CodexFetch {
  (url: string, init: RequestInit): Promise<CodexFetchResponse>;
}

export interface CodexClientOptions {
  /** Resolves a fresh OAuth access token + ChatGPT account id per call.
   *  Built by `makeAccessTokenProvider(store, 'openai')` in the factory. */
  tokenProvider: AccessTokenProvider;
  /** Model id with dots, e.g. `gpt-5.4` (pi-ai catalog uses dots, not dashes). */
  model: string;
  fetchImpl?: CodexFetch;
  /** Override the API base. Useful for proxies / tests. */
  apiBase?: string;
  /** Default per-call timeout in ms; per-call opts.timeoutMs wins. */
  defaultTimeoutMs?: number;
}

/** Aggregated usage extracted from the `response.completed` SSE event. */
export interface CodexUsage {
  /** Non-cached input tokens — OpenAI counts cached inside `input_tokens`, so
   *  we subtract `cached_tokens` to match Foreman's cost-attribution model. */
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

const DEFAULT_API_BASE = "https://chatgpt.com/backend-api";
const DEFAULT_TIMEOUT_MS = 60_000;
const RESPONSES_BETA = "responses=experimental";
const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

export class CodexLlmClient implements LlmClient {
  // To the rest of Foreman this is still the OpenAI provider — only auth_mode
  // differs. The factory dispatches to this class when auth_mode === 'oauth'.
  readonly providerId = "openai" as const;
  readonly model: string;
  private readonly tokenProvider: AccessTokenProvider;
  private readonly fetchImpl: CodexFetch;
  private readonly apiBase: string;
  private readonly defaultTimeoutMs: number;

  constructor(opts: CodexClientOptions) {
    this.tokenProvider = opts.tokenProvider;
    this.model = opts.model;
    this.fetchImpl =
      opts.fetchImpl ?? ((u, init) => fetch(u, init) as unknown as Promise<CodexFetchResponse>);
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
    const cred = await this.tokenProvider();
    if (!cred.accountId) {
      // The Codex backend keys every request to a ChatGPT account; without it
      // the request 401s with a less actionable message. Catch it early.
      throw new LlmProviderError(
        "Codex OAuth token has no ChatGPT account id — re-run " +
          "`foreman llm login openai`.",
        "openai",
      );
    }

    const sessionId = randomUUID();
    const url = `${this.apiBase}/codex/responses`;
    const body = JSON.stringify({
      model: this.model,
      // `store: false` is mandatory — the Codex backend rejects `true` with
      // "Store must be set to false". Reasoning is replayed across turns via
      // `include: ['reasoning.encrypted_content']` instead.
      store: false,
      stream: true,
      instructions: DEFAULT_INSTRUCTIONS,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: sessionId,
    });

    const headers: Record<string, string> = {
      authorization: `Bearer ${cred.accessToken}`,
      "chatgpt-account-id": cred.accountId,
      originator: CODEX_ORIGINATOR,
      "OpenAI-Beta": RESPONSES_BETA,
      "user-agent": `foreman (${platform()} ${release()}; ${arch()})`,
      accept: "text/event-stream",
      "content-type": "application/json",
      session_id: sessionId,
      "x-client-request-id": sessionId,
    };

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? this.defaultTimeoutMs,
    );
    const t0 = Date.now();
    let res: CodexFetchResponse;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new LlmProviderError(
        `Codex fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        "openai",
      );
    }

    if (!res.ok) {
      clearTimeout(timer);
      const text = await res.text().catch(() => "<no body>");
      if (
        res.status === 429 ||
        /usage_limit_reached|rate_limit_exceeded|usage_not_included/.test(text)
      ) {
        throw new LlmProviderError(
          "You've hit your ChatGPT usage limit — Codex will retry after the " +
            "next reset.",
          "openai",
        );
      }
      throw new LlmProviderError(`Codex HTTP ${res.status}: ${text}`, "openai");
    }

    if (!res.body) {
      clearTimeout(timer);
      throw new LlmProviderError(
        "Codex returned a 2xx with no body — stream missing.",
        "openai",
      );
    }

    let parsed: { text: string; usage: CodexUsage };
    try {
      parsed = await parseCodexSseStream(res.body);
    } finally {
      clearTimeout(timer);
    }
    const durationMs = Date.now() - t0;

    return {
      text: parsed.text,
      inputTokens: parsed.usage.inputTokens,
      outputTokens: parsed.usage.outputTokens,
      // ChatGPT subscription, not the OpenAI API budget — usage goes against
      // the user's plan limits instead of being billed per-token. Budget
      // alerts (which read costUsd) only fire for API-key spend, by design.
      costUsd: 0,
      durationMs,
      cacheHit: parsed.usage.cachedTokens > 0,
    };
  }
}

/** Parse a Codex Responses SSE stream into the final assistant text + usage.
 *  Exported for direct testing of the event handling. Throws LlmProviderError
 *  when the stream surfaces a `response.failed` / `error` event. */
export async function parseCodexSseStream(
  stream: ReadableStream<Uint8Array>,
): Promise<{ text: string; usage: CodexUsage }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let usage: CodexUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE events are separated by a blank line (\n\n). Pop complete events
    // out of the buffer; leave any trailing partial in place for the next
    // chunk to complete.
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const eventBlock = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const ev = parseSseEvent(eventBlock);
      if (ev?.textDelta) text += ev.textDelta;
      if (ev?.usage) usage = ev.usage;
      if (ev?.error) {
        throw new LlmProviderError(`Codex stream: ${ev.error}`, "openai");
      }
      sep = buffer.indexOf("\n\n");
    }
  }
  return { text, usage };
}

interface ParsedEvent {
  textDelta?: string;
  usage?: CodexUsage;
  error?: string;
}

interface CodexCompletedEvent {
  type?: string;
  delta?: string;
  error?: { message?: string };
  response?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
  };
}

function parseSseEvent(eventBlock: string): ParsedEvent | null {
  // Per the SSE spec multiple `data:` lines in one event are concatenated
  // with newlines. We rebuild that before JSON-parsing.
  const dataLines = eventBlock
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join("\n");
  if (dataStr === "[DONE]") return null;

  let event: CodexCompletedEvent;
  try {
    event = JSON.parse(dataStr) as CodexCompletedEvent;
  } catch {
    return null;
  }

  // The Codex backend emits `response.done` / `response.incomplete` in some
  // edge paths; treat them like `response.completed` for our purposes.
  switch (event.type) {
    case "response.output_text.delta":
      return { textDelta: event.delta ?? "" };
    case "response.completed":
    case "response.done":
    case "response.incomplete": {
      const u = event.response?.usage;
      if (!u) return null;
      const cached = u.input_tokens_details?.cached_tokens ?? 0;
      return {
        usage: {
          inputTokens: Math.max(0, (u.input_tokens ?? 0) - cached),
          outputTokens: u.output_tokens ?? 0,
          cachedTokens: cached,
        },
      };
    }
    case "response.failed":
    case "error":
      return { error: event.error?.message ?? "stream failed" };
    default:
      return null;
  }
}
