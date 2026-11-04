import {
  LlmProviderError,
  type LlmCallOptions,
  type LlmClient,
  type LlmResponse,
} from "../client.js";
import { CHATGPT_USAGE_URL, OPENAI_API } from "../oauth/oauth-providers.js";
import type { AccessTokenProvider } from "../oauth/token-refresh.js";

// =============================================================================
// Foreman's brain on the user's ChatGPT plan
// =============================================================================
//
// OpenAI's "ChatGPT plan usage" for open-source and locally hosted apps
// (developers.openai.com/siwc/token-sharing-open-source/models-and-inference):
// the public Responses API with the access token from Sign in with ChatGPT.
// `store: false` and `stream: true` are required, and a list of fields is
// refused, `max_output_tokens` and `temperature` among them. A plan error
// stops the call: it never falls over to another way of paying.
//
// ProviderId stays `'openai'`: to the factory and the budget tracker this is
// the same provider, and `auth_mode` tells them apart.

export interface ChatgptPlanFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  body: ReadableStream<Uint8Array> | null;
}

export interface ChatgptPlanFetch {
  (url: string, init: RequestInit): Promise<ChatgptPlanFetchResponse>;
}

export interface ChatgptPlanClientOptions {
  /** A fresh access token per call, from `makeAccessTokenProvider`. */
  tokenProvider: AccessTokenProvider;
  model: string;
  fetchImpl?: ChatgptPlanFetch;
  /** Override the API base. For tests. */
  apiBase?: string;
  /** Default per-call timeout in ms; per-call opts.timeoutMs wins. */
  defaultTimeoutMs?: number;
  /** Backoff between retries of a passing outage. */
  wait?: (ms: number) => Promise<void>;
}

/** Aggregated usage extracted from the `response.completed` SSE event. */
export interface ChatgptPlanUsage {
  /** Non-cached input tokens — OpenAI counts cached inside `input_tokens`, so
   *  we subtract `cached_tokens` to match Foreman's cost-attribution model. */
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";
const MAX_ATTEMPTS = 3;

export class ChatgptPlanLlmClient implements LlmClient {
  readonly providerId = "openai" as const;
  readonly model: string;
  private readonly tokenProvider: AccessTokenProvider;
  private readonly fetchImpl: ChatgptPlanFetch;
  private readonly apiBase: string;
  private readonly defaultTimeoutMs: number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(opts: ChatgptPlanClientOptions) {
    this.tokenProvider = opts.tokenProvider;
    this.model = opts.model;
    this.fetchImpl =
      opts.fetchImpl ?? ((u, init) => fetch(u, init) as unknown as Promise<ChatgptPlanFetchResponse>);
    this.apiBase = opts.apiBase ?? OPENAI_API;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.wait = opts.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async ping(): Promise<LlmResponse> {
    return this.call('Say "pong" in one word.', {
      feature: "test",
      maxTokens: 8,
      temperature: 0,
    });
  }

  async call(prompt: string, opts: LlmCallOptions): Promise<LlmResponse> {
    const { accessToken } = await this.tokenProvider();
    const body = JSON.stringify({
      model: this.model,
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
    });
    const t0 = Date.now();
    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.defaultTimeoutMs);
      try {
        const res = await this.post(accessToken, body, controller.signal);
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const failure = planFailure(res.status, text);
          if (failure.retry && attempt < MAX_ATTEMPTS) {
            await this.wait(attempt * 1000);
            continue;
          }
          throw new LlmProviderError(failure.message, "openai");
        }
        if (!res.body) {
          throw new LlmProviderError("OpenAI answered with no body.", "openai");
        }
        const parsed = await parseResponsesStream(res.body);
        return {
          text: parsed.text,
          inputTokens: parsed.usage.inputTokens,
          outputTokens: parsed.usage.outputTokens,
          // The user's ChatGPT plan, not an API budget: usage counts against
          // the plan, so budget alerts only fire for API-key spend.
          costUsd: 0,
          durationMs: Date.now() - t0,
          cacheHit: parsed.usage.cachedTokens > 0,
        };
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private async post(accessToken: string, body: string, signal: AbortSignal): Promise<ChatgptPlanFetchResponse> {
    try {
      return await this.fetchImpl(`${this.apiBase}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        body,
        signal,
      });
    } catch (err) {
      throw new LlmProviderError(
        `OpenAI request failed: ${err instanceof Error ? err.message : String(err)}`,
        "openai",
      );
    }
  }
}

/** What to tell the user about a refused request, per OpenAI's error guide. */
function planFailure(status: number, text: string): { message: string; retry: boolean } {
  const parsed = parseErrorBody(text);
  const code = parsed.code;
  if (code === "subscription_sharing_usage_limit_exceeded" || status === 429) {
    return { message: `You've hit your ChatGPT plan's limit. Manage usage: ${CHATGPT_USAGE_URL}`, retry: false };
  }
  if (code === "subscription_sharing_user_not_eligible") {
    return { message: "This ChatGPT plan can't be used here. Add an API key instead.", retry: false };
  }
  if (status === 401 || code === "subscription_sharing_invalid_user") {
    return { message: "ChatGPT didn't accept this sign-in. Run: foreman llm login openai", retry: false };
  }
  if (status === 503) {
    return { message: "ChatGPT plan use is unavailable right now. Try again later.", retry: true };
  }
  return { message: `OpenAI refused the request (HTTP ${status}${code ? `, ${code}` : ""}): ${parsed.detail}`, retry: false };
}

function parseErrorBody(text: string): { code: string | null; detail: string } {
  try {
    const body = JSON.parse(text) as { error?: { code?: string; message?: string }; detail?: string };
    return { code: body.error?.code ?? null, detail: body.error?.message ?? body.detail ?? "" };
  } catch {
    return { code: null, detail: text.slice(0, 200) };
  }
}

/** Parse a Responses stream into the final assistant text + usage. It only
 *  counts as an answer once `response.completed` arrives; a failed, incomplete
 *  or cut-off stream throws. */
export async function parseResponsesStream(
  stream: ReadableStream<Uint8Array>,
): Promise<{ text: string; usage: ChatgptPlanUsage }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let usage: ChatgptPlanUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let buffer = "";
  let completed = false;

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
      if (ev?.completed) completed = true;
      if (ev?.error) {
        throw new LlmProviderError(`OpenAI stream: ${ev.error}`, "openai");
      }
      sep = buffer.indexOf("\n\n");
    }
  }
  if (!completed) throw new LlmProviderError("OpenAI's stream ended before the answer did.", "openai");
  return { text, usage };
}

interface ParsedEvent {
  textDelta?: string;
  usage?: ChatgptPlanUsage;
  error?: string;
  completed?: boolean;
}

interface ResponsesEvent {
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

  let event: ResponsesEvent;
  try {
    event = JSON.parse(dataStr) as ResponsesEvent;
  } catch {
    return null;
  }

  switch (event.type) {
    case "response.output_text.delta":
      return { textDelta: event.delta ?? "" };
    case "response.incomplete":
      return { error: "the answer came back incomplete" };
    case "response.completed": {
      const u = event.response?.usage;
      if (!u) return { completed: true };
      const cached = u.input_tokens_details?.cached_tokens ?? 0;
      return {
        completed: true,
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
