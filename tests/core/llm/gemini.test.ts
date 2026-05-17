import { describe, expect, it, vi } from 'vitest'
import { LlmProviderError } from '../../../src/core/llm/client.js'
import {
  GeminiLlmClient,
  calculateCostUsd,
  type GeminiFetch,
} from '../../../src/core/llm/providers/gemini.js'

// =============================================================================
// Tests pin the Gemini client's contract: request shape, response parsing,
// error surfacing, timeout abort, pricing math, env-driven base override.
// Same coverage matrix as Anthropic + OpenAI so the factory (#296) can rely
// on uniform behaviour across providers.
// =============================================================================

interface MockResponse {
  status?: number
  body?: unknown
  textBody?: string
}

function makeFetch(plan: MockResponse[]): {
  fetchImpl: GeminiFetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  let cursor = 0
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl: GeminiFetch = async (url, init) => {
    calls.push({ url, init })
    const next = plan[cursor++] ?? { status: 200, body: { candidates: [] } }
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
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'pong' }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 8,
        candidatesTokenCount: 4,
        totalTokenCount: 12,
      },
    },
  }
}

describe('GeminiLlmClient — call', () => {
  it('POSTs to /v1beta/models/{model}:generateContent with correct headers + body', async () => {
    const f = makeFetch([happyResponse()])
    const client = new GeminiLlmClient({
      apiKey: 'AIza-test',
      model: 'gemini-2.0-flash',
      fetchImpl: f.fetchImpl,
    })
    await client.call('hello', { feature: 'test', maxTokens: 16 })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    )
    const init = f.calls[0]!.init
    const headers = init.headers as Record<string, string>
    expect(headers['x-goog-api-key']).toBe('AIza-test')
    expect(headers['content-type']).toBe('application/json')
    const body = JSON.parse(String(init.body)) as {
      contents: { role: string; parts: { text: string }[] }[]
      generationConfig: { maxOutputTokens: number; temperature: number }
    }
    expect(body.contents[0]!.role).toBe('user')
    expect(body.contents[0]!.parts[0]!.text).toBe('hello')
    expect(body.generationConfig.maxOutputTokens).toBe(16)
  })

  it('extracts text + tokens + computes cost from the response', async () => {
    const f = makeFetch([happyResponse()])
    const client = new GeminiLlmClient({
      apiKey: 'AIza',
      model: 'gemini-2.0-flash',
      fetchImpl: f.fetchImpl,
    })
    const res = await client.call('hi', { feature: 'test', maxTokens: 4 })
    expect(res.text).toBe('pong')
    expect(res.inputTokens).toBe(8)
    expect(res.outputTokens).toBe(4)
    // gemini-2.0-flash pricing: $0.10/MTok in, $0.40/MTok out
    // → (8*0.10 + 4*0.40) / 1e6 = (0.8 + 1.6) / 1e6 = 2.4 / 1e6
    expect(res.costUsd).toBeCloseTo(2.4 / 1_000_000, 12)
    expect(res.cacheHit).toBe(false)
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('joins multi-part text content', async () => {
    const f = makeFetch([
      {
        status: 200,
        body: {
          candidates: [
            {
              content: {
                parts: [{ text: 'foo ' }, { text: 'bar' }],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 2,
            candidatesTokenCount: 3,
          },
        },
      },
    ])
    const client = new GeminiLlmClient({
      apiKey: 'AIza',
      model: 'gemini-2.0-flash',
      fetchImpl: f.fetchImpl,
    })
    const res = await client.call('hi', { feature: 'test', maxTokens: 16 })
    expect(res.text).toBe('foo bar')
  })

  it('throws LlmProviderError on non-2xx response with HTTP body', async () => {
    const f = makeFetch([
      {
        status: 401,
        textBody: '{"error":{"code":401,"message":"API key not valid"}}',
      },
    ])
    const client = new GeminiLlmClient({
      apiKey: 'wrong',
      model: 'gemini-2.0-flash',
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
            code: 400,
            message: 'model gemini-imaginary not found',
            status: 'NOT_FOUND',
          },
        },
      },
    ])
    const client = new GeminiLlmClient({
      apiKey: 'AIza',
      model: 'gemini-imaginary',
      fetchImpl: f.fetchImpl,
    })
    await expect(
      client.call('hi', { feature: 'test', maxTokens: 4 }),
    ).rejects.toThrow(/gemini-imaginary not found/)
  })

  it('uses opts.timeoutMs to abort slow requests', async () => {
    const fetchImpl: GeminiFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    const client = new GeminiLlmClient({
      apiKey: 'AIza',
      model: 'gemini-2.0-flash',
      fetchImpl,
    })
    await expect(
      client.call('hi', { feature: 'test', maxTokens: 4, timeoutMs: 10 }),
    ).rejects.toThrow(LlmProviderError)
  })

  it('ping uses minimum maxTokens and the "test" feature label', async () => {
    const f = makeFetch([happyResponse()])
    const client = new GeminiLlmClient({
      apiKey: 'AIza',
      model: 'gemini-2.0-flash',
      fetchImpl: f.fetchImpl,
    })
    await client.ping()
    const body = JSON.parse(String(f.calls[0]!.init.body)) as {
      generationConfig: { maxOutputTokens: number }
    }
    expect(body.generationConfig.maxOutputTokens).toBeLessThanOrEqual(16)
  })

  it('default temperature = 0 (deterministic verification / report)', async () => {
    const f = makeFetch([happyResponse()])
    const client = new GeminiLlmClient({
      apiKey: 'AIza',
      model: 'gemini-2.0-flash',
      fetchImpl: f.fetchImpl,
    })
    await client.call('hi', { feature: 'test', maxTokens: 4 })
    const body = JSON.parse(String(f.calls[0]!.init.body)) as {
      generationConfig: { temperature: number }
    }
    expect(body.generationConfig.temperature).toBe(0)
  })

  it('honours custom apiBase override (proxy use case)', async () => {
    const f = makeFetch([happyResponse()])
    const client = new GeminiLlmClient({
      apiKey: 'AIza',
      model: 'gemini-2.0-flash',
      fetchImpl: f.fetchImpl,
      apiBase: 'https://proxy.internal',
    })
    await client.call('hi', { feature: 'test', maxTokens: 4 })
    expect(f.calls[0]!.url).toBe(
      'https://proxy.internal/v1beta/models/gemini-2.0-flash:generateContent',
    )
  })

  it('reads GEMINI_API_BASE env when no apiBase opt is set', async () => {
    const origEnv = process.env.GEMINI_API_BASE
    process.env.GEMINI_API_BASE = 'https://env-proxy.example'
    try {
      const f = makeFetch([happyResponse()])
      const client = new GeminiLlmClient({
        apiKey: 'AIza',
        model: 'gemini-2.0-flash',
        fetchImpl: f.fetchImpl,
      })
      await client.call('hi', { feature: 'test', maxTokens: 4 })
      expect(f.calls[0]!.url).toBe(
        'https://env-proxy.example/v1beta/models/gemini-2.0-flash:generateContent',
      )
    } finally {
      if (origEnv === undefined) {
        delete process.env.GEMINI_API_BASE
      } else {
        process.env.GEMINI_API_BASE = origEnv
      }
    }
  })

  it('opt apiBase wins over GEMINI_API_BASE env', async () => {
    const origEnv = process.env.GEMINI_API_BASE
    process.env.GEMINI_API_BASE = 'https://env-proxy.example'
    try {
      const f = makeFetch([happyResponse()])
      const client = new GeminiLlmClient({
        apiKey: 'AIza',
        model: 'gemini-2.0-flash',
        fetchImpl: f.fetchImpl,
        apiBase: 'https://opt-proxy.example',
      })
      await client.call('hi', { feature: 'test', maxTokens: 4 })
      expect(f.calls[0]!.url).toBe(
        'https://opt-proxy.example/v1beta/models/gemini-2.0-flash:generateContent',
      )
    } finally {
      if (origEnv === undefined) {
        delete process.env.GEMINI_API_BASE
      } else {
        process.env.GEMINI_API_BASE = origEnv
      }
    }
  })

  it('handles missing candidates gracefully (empty text)', async () => {
    const f = makeFetch([
      {
        status: 200,
        body: {
          candidates: [],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 },
        },
      },
    ])
    const client = new GeminiLlmClient({
      apiKey: 'AIza',
      model: 'gemini-2.0-flash',
      fetchImpl: f.fetchImpl,
    })
    const res = await client.call('hi', { feature: 'test', maxTokens: 4 })
    expect(res.text).toBe('')
  })
})

describe('calculateCostUsd — Gemini', () => {
  it.each([
    ['gemini-2.0-flash', 1_000_000, 0, 0.1],
    ['gemini-2.0-flash', 0, 1_000_000, 0.4],
    ['gemini-2.0-flash', 1_000_000, 1_000_000, 0.5],
    ['gemini-2.0-flash-lite', 1_000_000, 1_000_000, 0.375],
    ['gemini-2.0-pro', 1_000_000, 0, 1.25],
    ['gemini-2.0-pro', 0, 1_000_000, 5],
    ['gemini-1.5-flash-8b', 1_000_000, 1_000_000, 0.1875],
  ])('%s tokens in=%d out=%d → $%d', (model, inT, outT, expected) => {
    expect(calculateCostUsd(model, inT, outT)).toBeCloseTo(expected, 4)
  })

  it('falls back to gemini-2.0-flash pricing on unknown models (conservative)', () => {
    const cost = calculateCostUsd('gemini-future-9', 1_000_000, 0)
    expect(cost).toBeCloseTo(0.1, 4)
  })

  it('returns 0 when both token counts are 0', () => {
    expect(calculateCostUsd('gemini-2.0-flash', 0, 0)).toBe(0)
  })
})

describe('GeminiLlmClient — exposes providerId + model', () => {
  it('providerId is the literal "gemini"', () => {
    const client = new GeminiLlmClient({
      apiKey: 'k',
      model: 'gemini-2.0-flash',
      fetchImpl: vi.fn() as never,
    })
    expect(client.providerId).toBe('gemini')
    expect(client.model).toBe('gemini-2.0-flash')
  })
})
