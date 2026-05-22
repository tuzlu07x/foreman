import { describe, expect, it, vi } from "vitest";
import { LlmProviderError } from "../../../src/core/llm/client.js";
import {
  OpenAILlmClient,
  calculateCostUsd,
  parseOpenAIError,
  type OpenAIFetch,
} from "../../../src/core/llm/providers/openai.js";

interface MockResponse {
  status?: number;
  body?: unknown;
  textBody?: string;
}

function makeFetch(plan: MockResponse[]): {
  fetchImpl: OpenAIFetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  let cursor = 0;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: OpenAIFetch = async (url, init) => {
    calls.push({ url, init });
    const next = plan[cursor++] ?? { status: 200, body: { choices: [] } };
    return {
      ok: (next.status ?? 200) >= 200 && (next.status ?? 200) < 300,
      status: next.status ?? 200,
      json: async () => next.body,
      text: async () => next.textBody ?? JSON.stringify(next.body),
    };
  };
  return { fetchImpl, calls };
}

function happyResponse(): MockResponse {
  return {
    status: 200,
    body: {
      choices: [
        {
          message: { role: "assistant", content: "pong" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    },
  };
}

function error400(param: string, message: string): MockResponse {
  return {
    status: 400,
    textBody: JSON.stringify({
      error: { type: "invalid_request_error", param, message },
    }),
  };
}

const MAX_TOKENS_400 =
  "Unsupported parameter: 'max_tokens' is not supported with this model. " +
  "Use 'max_completion_tokens' instead.";
const TEMPERATURE_400 =
  "Unsupported value: 'temperature' does not support 0.3 with this model. " +
  "Only the default (1) value is supported.";

function bodyOf(
  f: ReturnType<typeof makeFetch>,
  i: number,
): Record<string, unknown> {
  return JSON.parse(String(f.calls[i]!.init.body)) as Record<string, unknown>;
}

describe("OpenAILlmClient — call", () => {
  it("POSTs to /v1/chat/completions with the correct headers + body shape", async () => {
    const f = makeFetch([happyResponse()]);
    const client = new OpenAILlmClient({
      apiKey: "sk-proj-test",
      model: "gpt-4o-mini",
      fetchImpl: f.fetchImpl,
    });
    await client.call("hello", { feature: "test", maxTokens: 16 });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    const init = f.calls[0]!.init;
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-proj-test");
    expect(headers["content-type"]).toBe("application/json");
    const body = bodyOf(f, 0);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.max_tokens).toBe(16);
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("retries with `max_completion_tokens` after a 400 telling it to", async () => {
    const f = makeFetch([
      error400("max_tokens", MAX_TOKENS_400),
      happyResponse(),
    ]);
    const client = new OpenAILlmClient({
      apiKey: "sk-proj",
      model: "gpt-5-mini",
      fetchImpl: f.fetchImpl,
    });
    const res = await client.call("hi", { feature: "test", maxTokens: 32 });
    expect(res.text).toBe("pong");
    expect(f.calls).toHaveLength(2);
    // First attempt used the legacy field; retry renamed it.
    expect(bodyOf(f, 0).max_tokens).toBe(32);
    expect(bodyOf(f, 1).max_completion_tokens).toBe(32);
    expect(bodyOf(f, 1).max_tokens).toBeUndefined();
  });

  it("retries without `temperature` after a 400 rejecting it", async () => {
    const f = makeFetch([
      error400("temperature", TEMPERATURE_400),
      happyResponse(),
    ]);
    const client = new OpenAILlmClient({
      apiKey: "sk-proj",
      model: "gpt-5-mini",
      fetchImpl: f.fetchImpl,
    });
    const res = await client.call("hi", {
      feature: "test",
      maxTokens: 16,
      temperature: 0.3,
    });
    expect(res.text).toBe("pong");
    expect(f.calls).toHaveLength(2);
    expect(bodyOf(f, 0).temperature).toBe(0.3);
    expect(bodyOf(f, 1).temperature).toBeUndefined();
  });

  it("adapts both fields across successive 400s", async () => {
    const f = makeFetch([
      error400("max_tokens", MAX_TOKENS_400),
      error400("temperature", TEMPERATURE_400),
      happyResponse(),
    ]);
    const client = new OpenAILlmClient({
      apiKey: "sk-proj",
      model: "gpt-5-mini",
      fetchImpl: f.fetchImpl,
    });
    const res = await client.call("hi", {
      feature: "test",
      maxTokens: 16,
      temperature: 0.3,
    });
    expect(res.text).toBe("pong");
    expect(f.calls).toHaveLength(3);
    const final = bodyOf(f, 2);
    expect(final.max_completion_tokens).toBe(16);
    expect(final.max_tokens).toBeUndefined();
    expect(final.temperature).toBeUndefined();
  });

  it("memoises the learned shape — the next call gets it right first try", async () => {
    const f = makeFetch([
      error400("temperature", TEMPERATURE_400),
      happyResponse(),
      happyResponse(),
    ]);
    const client = new OpenAILlmClient({
      apiKey: "sk-proj",
      model: "gpt-5-mini",
      fetchImpl: f.fetchImpl,
    });
    await client.call("one", {
      feature: "test",
      maxTokens: 16,
      temperature: 0.3,
    });
    await client.call("two", {
      feature: "test",
      maxTokens: 16,
      temperature: 0.3,
    });
    expect(f.calls).toHaveLength(3);
    expect(bodyOf(f, 2).temperature).toBeUndefined();
  });

  it("keeps the legacy shape (max_tokens + temperature) for GPT-4 models", async () => {
    const f = makeFetch([happyResponse()]);
    const client = new OpenAILlmClient({
      apiKey: "sk-proj",
      model: "gpt-4o-mini",
      fetchImpl: f.fetchImpl,
    });
    await client.call("hi", {
      feature: "test",
      maxTokens: 16,
      temperature: 0.3,
    });
    expect(f.calls).toHaveLength(1);
    const body = bodyOf(f, 0);
    expect(body.max_tokens).toBe(16);
    expect(body.temperature).toBe(0.3);
  });

  it("throws on a 400 it cannot adapt — no retry", async () => {
    const f = makeFetch([
      error400("messages", "Missing required parameter: 'messages'."),
    ]);
    const client = new OpenAILlmClient({
      apiKey: "sk-proj",
      model: "gpt-5-mini",
      fetchImpl: f.fetchImpl,
    });
    await expect(
      client.call("hi", { feature: "test", maxTokens: 4 }),
    ).rejects.toThrow(LlmProviderError);
    expect(f.calls).toHaveLength(1);
  });

  it("gives up (no infinite loop) if the same field keeps 400-ing", async () => {
    const f = makeFetch([
      error400("temperature", TEMPERATURE_400),
      error400("temperature", TEMPERATURE_400),
    ]);
    const client = new OpenAILlmClient({
      apiKey: "sk-proj",
      model: "gpt-5-mini",
      fetchImpl: f.fetchImpl,
    });
    await expect(
      client.call("hi", { feature: "test", maxTokens: 4, temperature: 0.3 }),
    ).rejects.toThrow(LlmProviderError);
    // Adapted once, then the field is already dropped → can't adapt again.
    expect(f.calls).toHaveLength(2);
  });

  it("extracts text + tokens + computes cost from the response", async () => {
    const f = makeFetch([happyResponse()]);
    const client = new OpenAILlmClient({
      apiKey: "sk-proj",
      model: "gpt-4o-mini",
      fetchImpl: f.fetchImpl,
    });
    const res = await client.call("hi", { feature: "test", maxTokens: 4 });
    expect(res.text).toBe("pong");
    expect(res.inputTokens).toBe(8);
    expect(res.outputTokens).toBe(4);
    // gpt-4o-mini pricing: $0.15/MTok in, $0.60/MTok out
    // → (8*0.15 + 4*0.60) / 1e6 = (1.2 + 2.4) / 1e6 = 3.6 / 1e6
    expect(res.costUsd).toBeCloseTo(3.6 / 1_000_000, 12);
    expect(res.cacheHit).toBe(false);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("throws LlmProviderError on non-2xx response with HTTP body", async () => {
    const f = makeFetch([
      {
        status: 401,
        textBody: '{"error":{"message":"invalid x-api-key"}}',
      },
    ]);
    const client = new OpenAILlmClient({
      apiKey: "wrong",
      model: "gpt-4o-mini",
      fetchImpl: f.fetchImpl,
    });
    await expect(
      client.call("hi", { feature: "test", maxTokens: 4 }),
    ).rejects.toThrow(LlmProviderError);
  });

  it("throws LlmProviderError on API-level error body", async () => {
    const f = makeFetch([
      {
        status: 200,
        body: {
          error: {
            type: "invalid_request_error",
            message: "model does not exist",
          },
        },
      },
    ]);
    const client = new OpenAILlmClient({
      apiKey: "sk-proj",
      model: "gpt-imaginary",
      fetchImpl: f.fetchImpl,
    });
    await expect(
      client.call("hi", { feature: "test", maxTokens: 4 }),
    ).rejects.toThrow(/model does not exist/);
  });

  it("uses opts.timeoutMs to abort slow requests", async () => {
    const fetchImpl: OpenAIFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    const client = new OpenAILlmClient({
      apiKey: "sk-proj",
      model: "gpt-4o-mini",
      fetchImpl,
    });
    await expect(
      client.call("hi", { feature: "test", maxTokens: 4, timeoutMs: 10 }),
    ).rejects.toThrow(LlmProviderError);
  });

  it('ping uses minimum maxTokens and the "test" feature label', async () => {
    const f = makeFetch([happyResponse()]);
    const client = new OpenAILlmClient({
      apiKey: "sk-proj",
      model: "gpt-4o-mini",
      fetchImpl: f.fetchImpl,
    });
    await client.ping();
    const body = bodyOf(f, 0) as { max_tokens: number };
    expect(body.max_tokens).toBeLessThanOrEqual(16);
  });

  it("default temperature = 0 (deterministic verification / report)", async () => {
    const f = makeFetch([happyResponse()]);
    const client = new OpenAILlmClient({
      apiKey: "sk-proj",
      model: "gpt-4o-mini",
      fetchImpl: f.fetchImpl,
    });
    await client.call("hi", { feature: "test", maxTokens: 4 });
    expect(bodyOf(f, 0).temperature).toBe(0);
  });

  it("honours custom apiBase override (proxy use case)", async () => {
    const f = makeFetch([happyResponse()]);
    const client = new OpenAILlmClient({
      apiKey: "sk-proj",
      model: "gpt-4o-mini",
      fetchImpl: f.fetchImpl,
      apiBase: "https://proxy.internal",
    });
    await client.call("hi", { feature: "test", maxTokens: 4 });
    expect(f.calls[0]!.url).toBe("https://proxy.internal/v1/chat/completions");
  });

  it("reads OPENAI_API_BASE env when no apiBase opt is set", async () => {
    const origEnv = process.env.OPENAI_API_BASE;
    process.env.OPENAI_API_BASE = "https://env-proxy.example";
    try {
      const f = makeFetch([happyResponse()]);
      const client = new OpenAILlmClient({
        apiKey: "sk-proj",
        model: "gpt-4o-mini",
        fetchImpl: f.fetchImpl,
      });
      await client.call("hi", { feature: "test", maxTokens: 4 });
      expect(f.calls[0]!.url).toBe(
        "https://env-proxy.example/v1/chat/completions",
      );
    } finally {
      if (origEnv === undefined) {
        delete process.env.OPENAI_API_BASE;
      } else {
        process.env.OPENAI_API_BASE = origEnv;
      }
    }
  });

  it("opt apiBase wins over OPENAI_API_BASE env", async () => {
    const origEnv = process.env.OPENAI_API_BASE;
    process.env.OPENAI_API_BASE = "https://env-proxy.example";
    try {
      const f = makeFetch([happyResponse()]);
      const client = new OpenAILlmClient({
        apiKey: "sk-proj",
        model: "gpt-4o-mini",
        fetchImpl: f.fetchImpl,
        apiBase: "https://opt-proxy.example",
      });
      await client.call("hi", { feature: "test", maxTokens: 4 });
      expect(f.calls[0]!.url).toBe(
        "https://opt-proxy.example/v1/chat/completions",
      );
    } finally {
      if (origEnv === undefined) {
        delete process.env.OPENAI_API_BASE;
      } else {
        process.env.OPENAI_API_BASE = origEnv;
      }
    }
  });

  it("sends openai-organization header when set", async () => {
    const f = makeFetch([happyResponse()]);
    const client = new OpenAILlmClient({
      apiKey: "sk-proj",
      model: "gpt-4o-mini",
      fetchImpl: f.fetchImpl,
      organisation: "org-foreman",
    });
    await client.call("hi", { feature: "test", maxTokens: 4 });
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers["openai-organization"]).toBe("org-foreman");
  });

  it("handles missing content gracefully (no choices)", async () => {
    const f = makeFetch([
      {
        status: 200,
        body: {
          choices: [],
          usage: { prompt_tokens: 0, completion_tokens: 0 },
        },
      },
    ]);
    const client = new OpenAILlmClient({
      apiKey: "sk-proj",
      model: "gpt-4o-mini",
      fetchImpl: f.fetchImpl,
    });
    const res = await client.call("hi", { feature: "test", maxTokens: 4 });
    expect(res.text).toBe("");
  });
});

describe("calculateCostUsd — OpenAI", () => {
  it.each([
    ["gpt-4o-mini", 1_000_000, 0, 0.15],
    ["gpt-4o-mini", 0, 1_000_000, 0.6],
    ["gpt-4o-mini", 1_000_000, 1_000_000, 0.75],
    ["gpt-4o", 1_000_000, 0, 2.5],
    ["gpt-4o", 0, 1_000_000, 10],
    ["gpt-5-nano", 1_000_000, 1_000_000, 0.45],
    ["o1", 1_000_000, 1_000_000, 75],
  ])("%s tokens in=%d out=%d → $%d", (model, inT, outT, expected) => {
    expect(calculateCostUsd(model, inT, outT)).toBeCloseTo(expected, 4);
  });

  it("falls back to gpt-4o-mini pricing on unknown models (conservative)", () => {
    const cost = calculateCostUsd("gpt-future-99", 1_000_000, 0);
    expect(cost).toBeCloseTo(0.15, 4);
  });

  it("returns 0 when both token counts are 0", () => {
    expect(calculateCostUsd("gpt-4o-mini", 0, 0)).toBe(0);
  });
});

describe("parseOpenAIError", () => {
  it("extracts the error object from a well-formed body", () => {
    const err = parseOpenAIError(
      JSON.stringify({
        error: { message: "boom", param: "temperature", code: "bad" },
      }),
    );
    expect(err).toEqual({ message: "boom", param: "temperature", code: "bad" });
  });

  it("returns null for a body that is not JSON", () => {
    expect(parseOpenAIError("<html>502 Bad Gateway</html>")).toBeNull();
    expect(parseOpenAIError("")).toBeNull();
  });

  it("returns null for JSON with no error object", () => {
    expect(parseOpenAIError('{"ok":true}')).toBeNull();
    expect(parseOpenAIError('"just a string"')).toBeNull();
  });
});

describe("OpenAILlmClient — exposes providerId + model", () => {
  it('providerId is the literal "openai"', () => {
    const client = new OpenAILlmClient({
      apiKey: "k",
      model: "gpt-4o-mini",
      fetchImpl: vi.fn() as never,
    });
    expect(client.providerId).toBe("openai");
    expect(client.model).toBe("gpt-4o-mini");
  });
});
