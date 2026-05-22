import { describe, expect, it, vi } from 'vitest'
import { LlmProviderError } from '../../../src/core/llm/client.js'
import {
  OpenAILlmClient,
  calculateCostUsd,
  pickTokenLimitField,
  type OpenAIFetch,
} from '../../../src/core/llm/providers/openai.js'

// =============================================================================
// Tests pin the OpenAI client's contract: request shape, response parsing,
// error surfacing, timeout abort, pricing math, env-driven base override.
// Same matrix the Anthropic tests cover so the factory (#296) can rely on
// uniform behaviour across providers.
// =============================================================================

interface MockResponse {
  status?: number
  body?: unknown
  textBody?: string
}

function makeFetch(plan: MockResponse[]): {
  fetchImpl: OpenAIFetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  let cursor = 0
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl: OpenAIFetch = async (url, init) => {
    calls.push({ url, init })
    const next = plan[cursor++] ?? { status: 200, body: { choices: [] } }
    return {
      ok: (next.status ?? 200) >= 200 && (next.status ?? 200) < 300,
      status: next.status ?? 200,
      json: async () => next.body,
      text: async () => next.textBody ?? JSON.stringify(next.body),
    }
  }
  return { fetchImpl, calls }
}

function happyResponse(): MockResponse {
  return {
    status: 200,
    body: {
      choices: [
        {
          message: { role: 'assistant', content: 'pong' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    },
  }
}

describe('OpenAILlmClient — call', () => {
  it('POSTs to /v1/chat/completions with the correct headers + body shape', async () => {
    const f = makeFetch([happyResponse()])
    const client = new OpenAILlmClient({
      apiKey: 'sk-proj-test',
      model: 'gpt-4o-mini',
      fetchImpl: f.fetchImpl,
    })
    await client.call('hello', { feature: 'test', maxTokens: 16 })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions')
    const init = f.calls[0]!.init
    const headers = init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer sk-proj-test')
    expect(headers['content-type']).toBe('application/json')
    const body = JSON.parse(String(init.body)) as {
      model: string
      messages: { role: string; content: string }[]
      max_tokens: number
    }
    expect(body.model).toBe('gpt-4o-mini')
    expect(body.max_tokens).toBe(16)
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hello' })
  })

  // QA17 — GPT-5 / o1 / o3 / o4 families reject `max_tokens` with HTTP
  // 400. Pre-fix, `foreman hello` against a gpt-5* model failed
  // immediately with that error and orchestrator_chat looked broken.
  it('sends `max_completion_tokens` (not `max_tokens`) for gpt-5 family', async () => {
    const f = makeFetch([happyResponse()])
    const client = new OpenAILlmClient({
      apiKey: 'sk-proj',
      model: 'gpt-5-mini',
      fetchImpl: f.fetchImpl,
    })
    await client.call('hi', { feature: 'test', maxTokens: 32 })
    const body = JSON.parse(String(f.calls[0]!.init.body)) as Record<
      string,
      unknown
    >
    expect(body.max_completion_tokens).toBe(32)
    expect(body.max_tokens).toBeUndefined()
  })

  it('sends `max_completion_tokens` for the o1 / o3 / o4 reasoning families', async () => {
    for (const model of ['o1-mini', 'o3', 'o4-preview', 'gpt-5.5']) {
      const f = makeFetch([happyResponse()])
      const client = new OpenAILlmClient({
        apiKey: 'sk-proj',
        model,
        fetchImpl: f.fetchImpl,
      })
      await client.call('hi', { feature: 'test', maxTokens: 16 })
      const body = JSON.parse(String(f.calls[0]!.init.body)) as Record<
        string,
        unknown
      >
      expect(body.max_completion_tokens).toBe(16)
      expect(body.max_tokens).toBeUndefined()
    }
  })

  it('keeps `max_tokens` for legacy gpt-4o / gpt-4 / gpt-3.5 models', async () => {
    for (const model of ['gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo']) {
      const f = makeFetch([happyResponse()])
      const client = new OpenAILlmClient({
        apiKey: 'sk-proj',
        model,
        fetchImpl: f.fetchImpl,
      })
      await client.call('hi', { feature: 'test', maxTokens: 16 })
      const body = JSON.parse(String(f.calls[0]!.init.body)) as Record<
        string,
        unknown
      >
      expect(body.max_tokens).toBe(16)
      expect(body.max_completion_tokens).toBeUndefined()
    }
  })

  it('extracts text + tokens + computes cost from the response', async () => {
    const f = makeFetch([happyResponse()])
    const client = new OpenAILlmClient({
      apiKey: 'sk-proj',
      model: 'gpt-4o-mini',
      fetchImpl: f.fetchImpl,
    })
    const res = await client.call('hi', { feature: 'test', maxTokens: 4 })
    expect(res.text).toBe('pong')
    expect(res.inputTokens).toBe(8)
    expect(res.outputTokens).toBe(4)
    // gpt-4o-mini pricing: $0.15/MTok in, $0.60/MTok out
    // → (8*0.15 + 4*0.60) / 1e6 = (1.2 + 2.4) / 1e6 = 3.6 / 1e6
    expect(res.costUsd).toBeCloseTo(3.6 / 1_000_000, 12)
    expect(res.cacheHit).toBe(false)
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('throws LlmProviderError on non-2xx response with HTTP body', async () => {
    const f = makeFetch([
      {
        status: 401,
        textBody: '{"error":{"message":"invalid x-api-key"}}',
      },
    ])
    const client = new OpenAILlmClient({
      apiKey: 'wrong',
      model: 'gpt-4o-mini',
      fetchImpl: f.fetchImpl,
    })
    await expect(
      client.call('hi', { feature: 'test', maxTokens: 4 }),
    ).rejects.toThrow(LlmProviderError)
  })

  it('throws LlmProviderError on API-level error body', async () => {
    const f = makeFetch([
      {
        status: 200,
        body: {
          error: {
            type: 'invalid_request_error',
            message: 'model does not exist',
          },
        },
      },
    ])
    const client = new OpenAILlmClient({
      apiKey: 'sk-proj',
      model: 'gpt-imaginary',
      fetchImpl: f.fetchImpl,
    })
    await expect(
      client.call('hi', { feature: 'test', maxTokens: 4 }),
    ).rejects.toThrow(/model does not exist/)
  })

  it('uses opts.timeoutMs to abort slow requests', async () => {
    const fetchImpl: OpenAIFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    const client = new OpenAILlmClient({
      apiKey: 'sk-proj',
      model: 'gpt-4o-mini',
      fetchImpl,
    })
    await expect(
      client.call('hi', { feature: 'test', maxTokens: 4, timeoutMs: 10 }),
    ).rejects.toThrow(LlmProviderError)
  })

  it('ping uses minimum maxTokens and the "test" feature label', async () => {
    const f = makeFetch([happyResponse()])
    const client = new OpenAILlmClient({
      apiKey: 'sk-proj',
      model: 'gpt-4o-mini',
      fetchImpl: f.fetchImpl,
    })
    await client.ping()
    const body = JSON.parse(String(f.calls[0]!.init.body)) as {
      max_tokens: number
    }
    expect(body.max_tokens).toBeLessThanOrEqual(16)
  })

  it('default temperature = 0 (deterministic verification / report)', async () => {
    const f = makeFetch([happyResponse()])
    const client = new OpenAILlmClient({
      apiKey: 'sk-proj',
      model: 'gpt-4o-mini',
      fetchImpl: f.fetchImpl,
    })
    await client.call('hi', { feature: 'test', maxTokens: 4 })
    const body = JSON.parse(String(f.calls[0]!.init.body)) as {
      temperature: number
    }
    expect(body.temperature).toBe(0)
  })

  it('honours custom apiBase override (proxy use case)', async () => {
    const f = makeFetch([happyResponse()])
    const client = new OpenAILlmClient({
      apiKey: 'sk-proj',
      model: 'gpt-4o-mini',
      fetchImpl: f.fetchImpl,
      apiBase: 'https://proxy.internal',
    })
    await client.call('hi', { feature: 'test', maxTokens: 4 })
    expect(f.calls[0]!.url).toBe(
      'https://proxy.internal/v1/chat/completions',
    )
  })

  it('reads OPENAI_API_BASE env when no apiBase opt is set', async () => {
    const origEnv = process.env.OPENAI_API_BASE
    process.env.OPENAI_API_BASE = 'https://env-proxy.example'
    try {
      const f = makeFetch([happyResponse()])
      const client = new OpenAILlmClient({
        apiKey: 'sk-proj',
        model: 'gpt-4o-mini',
        fetchImpl: f.fetchImpl,
      })
      await client.call('hi', { feature: 'test', maxTokens: 4 })
      expect(f.calls[0]!.url).toBe(
        'https://env-proxy.example/v1/chat/completions',
      )
    } finally {
      if (origEnv === undefined) {
        delete process.env.OPENAI_API_BASE
      } else {
        process.env.OPENAI_API_BASE = origEnv
      }
    }
  })

  it('opt apiBase wins over OPENAI_API_BASE env', async () => {
    const origEnv = process.env.OPENAI_API_BASE
    process.env.OPENAI_API_BASE = 'https://env-proxy.example'
    try {
      const f = makeFetch([happyResponse()])
      const client = new OpenAILlmClient({
        apiKey: 'sk-proj',
        model: 'gpt-4o-mini',
        fetchImpl: f.fetchImpl,
        apiBase: 'https://opt-proxy.example',
      })
      await client.call('hi', { feature: 'test', maxTokens: 4 })
      expect(f.calls[0]!.url).toBe(
        'https://opt-proxy.example/v1/chat/completions',
      )
    } finally {
      if (origEnv === undefined) {
        delete process.env.OPENAI_API_BASE
      } else {
        process.env.OPENAI_API_BASE = origEnv
      }
    }
  })

  it('sends openai-organization header when set', async () => {
    const f = makeFetch([happyResponse()])
    const client = new OpenAILlmClient({
      apiKey: 'sk-proj',
      model: 'gpt-4o-mini',
      fetchImpl: f.fetchImpl,
      organisation: 'org-foreman',
    })
    await client.call('hi', { feature: 'test', maxTokens: 4 })
    const headers = f.calls[0]!.init.headers as Record<string, string>
    expect(headers['openai-organization']).toBe('org-foreman')
  })

  it('handles missing content gracefully (no choices)', async () => {
    const f = makeFetch([
      {
        status: 200,
        body: {
          choices: [],
          usage: { prompt_tokens: 0, completion_tokens: 0 },
        },
      },
    ])
    const client = new OpenAILlmClient({
      apiKey: 'sk-proj',
      model: 'gpt-4o-mini',
      fetchImpl: f.fetchImpl,
    })
    const res = await client.call('hi', { feature: 'test', maxTokens: 4 })
    expect(res.text).toBe('')
  })
})

describe('calculateCostUsd — OpenAI', () => {
  it.each([
    ['gpt-4o-mini', 1_000_000, 0, 0.15],
    ['gpt-4o-mini', 0, 1_000_000, 0.6],
    ['gpt-4o-mini', 1_000_000, 1_000_000, 0.75],
    ['gpt-4o', 1_000_000, 0, 2.5],
    ['gpt-4o', 0, 1_000_000, 10],
    ['gpt-5-nano', 1_000_000, 1_000_000, 0.45],
    ['o1', 1_000_000, 1_000_000, 75],
  ])('%s tokens in=%d out=%d → $%d', (model, inT, outT, expected) => {
    expect(calculateCostUsd(model, inT, outT)).toBeCloseTo(expected, 4)
  })

  it('falls back to gpt-4o-mini pricing on unknown models (conservative)', () => {
    const cost = calculateCostUsd('gpt-future-99', 1_000_000, 0)
    expect(cost).toBeCloseTo(0.15, 4)
  })

  it('returns 0 when both token counts are 0', () => {
    expect(calculateCostUsd('gpt-4o-mini', 0, 0)).toBe(0)
  })
})

describe('pickTokenLimitField', () => {
  it('returns max_completion_tokens for gpt-5 / o1 / o3 / o4 families', () => {
    for (const m of [
      'gpt-5',
      'gpt-5-mini',
      'gpt-5.5',
      'GPT-5-PREVIEW',
      'o1',
      'o1-mini',
      'o1-preview',
      'o3',
      'o3-mini',
      'o4',
    ]) {
      expect(pickTokenLimitField(m)).toBe('max_completion_tokens')
    }
  })

  it('returns max_tokens for gpt-4* / gpt-3.5 / unknown models', () => {
    for (const m of [
      'gpt-4o-mini',
      'gpt-4o',
      'gpt-4-turbo',
      'gpt-3.5-turbo',
      'some-unknown-model',
    ]) {
      expect(pickTokenLimitField(m)).toBe('max_tokens')
    }
  })
})

describe('OpenAILlmClient — exposes providerId + model', () => {
  it('providerId is the literal "openai"', () => {
    const client = new OpenAILlmClient({
      apiKey: 'k',
      model: 'gpt-4o-mini',
      fetchImpl: vi.fn() as never,
    })
    expect(client.providerId).toBe('openai')
    expect(client.model).toBe('gpt-4o-mini')
  })
})
