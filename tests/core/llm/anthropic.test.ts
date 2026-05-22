import { describe, expect, it, vi } from 'vitest'
import { LlmProviderError } from '../../../src/core/llm/client.js'
import {
  AnthropicLlmClient,
  calculateCostUsd,
  type AnthropicFetch,
} from '../../../src/core/llm/providers/anthropic.js'

interface MockResponse {
  status?: number
  body?: unknown
  textBody?: string
}

function makeFetch(plan: MockResponse[]): {
  fetchImpl: AnthropicFetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  let cursor = 0
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl: AnthropicFetch = async (url, init) => {
    calls.push({ url, init })
    const next = plan[cursor++] ?? { status: 200, body: { content: [] } }
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
      content: [{ type: 'text', text: 'pong' }],
      usage: { input_tokens: 8, output_tokens: 4 },
    },
  }
}

describe('AnthropicLlmClient — call', () => {
  it('POSTs to /v1/messages with the correct headers + body shape', async () => {
    const f = makeFetch([happyResponse()])
    const client = new AnthropicLlmClient({
      apiKey: 'sk-ant-test',
      model: 'claude-haiku-4-5',
      fetchImpl: f.fetchImpl,
    })
    await client.call('hello', { feature: 'test', maxTokens: 16 })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.url).toBe('https://api.anthropic.com/v1/messages')
    const init = f.calls[0]!.init
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['content-type']).toBe('application/json')
    const body = JSON.parse(String(init.body)) as {
      model: string
      messages: { role: string; content: string }[]
      max_tokens: number
    }
    expect(body.model).toBe('claude-haiku-4-5')
    expect(body.max_tokens).toBe(16)
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hello' })
  })

  it('extracts text + tokens + computes cost from the response', async () => {
    const f = makeFetch([happyResponse()])
    const client = new AnthropicLlmClient({
      apiKey: 'sk-ant',
      model: 'claude-haiku-4-5',
      fetchImpl: f.fetchImpl,
    })
    const res = await client.call('hi', { feature: 'test', maxTokens: 4 })
    expect(res.text).toBe('pong')
    expect(res.inputTokens).toBe(8)
    expect(res.outputTokens).toBe(4)
    // Haiku pricing: $1/MTok in, $5/MTok out → (8*1 + 4*5)/1e6 = 28/1e6
    expect(res.costUsd).toBeCloseTo(28 / 1_000_000, 12)
    expect(res.cacheHit).toBe(false)
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('throws LlmProviderError on non-2xx response with HTTP body', async () => {
    const f = makeFetch([
      { status: 401, textBody: 'unauthorized: bad key' },
    ])
    const client = new AnthropicLlmClient({
      apiKey: 'wrong',
      model: 'claude-haiku-4-5',
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
        body: { error: { type: 'invalid_request_error', message: 'bad model' } },
      },
    ])
    const client = new AnthropicLlmClient({
      apiKey: 'sk-ant',
      model: 'doesnt-exist',
      fetchImpl: f.fetchImpl,
    })
    await expect(
      client.call('hi', { feature: 'test', maxTokens: 4 }),
    ).rejects.toThrow(/bad model/)
  })

  it('uses opts.timeoutMs to abort slow requests', async () => {
    // fetch that never resolves until aborted
    const fetchImpl: AnthropicFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    const client = new AnthropicLlmClient({
      apiKey: 'sk-ant',
      model: 'claude-haiku-4-5',
      fetchImpl,
    })
    await expect(
      client.call('hi', { feature: 'test', maxTokens: 4, timeoutMs: 10 }),
    ).rejects.toThrow(LlmProviderError)
  })

  it('ping uses minimum maxTokens and the "test" feature label', async () => {
    const f = makeFetch([happyResponse()])
    const client = new AnthropicLlmClient({
      apiKey: 'sk-ant',
      model: 'claude-haiku-4-5',
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
    const client = new AnthropicLlmClient({
      apiKey: 'sk-ant',
      model: 'claude-haiku-4-5',
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
    const client = new AnthropicLlmClient({
      apiKey: 'sk-ant',
      model: 'claude-haiku-4-5',
      fetchImpl: f.fetchImpl,
      apiBase: 'https://proxy.internal',
    })
    await client.call('hi', { feature: 'test', maxTokens: 4 })
    expect(f.calls[0]!.url).toBe('https://proxy.internal/v1/messages')
  })
})

describe('calculateCostUsd', () => {
  it.each([
    ['claude-haiku-4-5', 1_000_000, 0, 1.0],
    ['claude-haiku-4-5', 0, 1_000_000, 5.0],
    ['claude-haiku-4-5-20251001', 1_000_000, 1_000_000, 6.0],
    ['claude-sonnet-4-6', 1_000_000, 0, 3.0],
    ['claude-opus-4-7', 0, 1_000_000, 75.0],
  ])('%s tokens in=%d out=%d → $%d', (model, inT, outT, expected) => {
    expect(calculateCostUsd(model, inT, outT)).toBeCloseTo(expected, 4)
  })

  it('falls back to Haiku pricing on unknown models (conservative)', () => {
    const cost = calculateCostUsd('future-model-7', 1_000_000, 0)
    expect(cost).toBeCloseTo(1, 4) // Haiku input pricing
  })

  it('returns 0 when both token counts are 0', () => {
    expect(calculateCostUsd('claude-haiku-4-5', 0, 0)).toBe(0)
  })
})

describe('AnthropicLlmClient — exposes providerId + model', () => {
  it('providerId is the literal "anthropic"', () => {
    const client = new AnthropicLlmClient({
      apiKey: 'k',
      model: 'claude-haiku-4-5',
      fetchImpl: vi.fn() as never,
    })
    expect(client.providerId).toBe('anthropic')
    expect(client.model).toBe('claude-haiku-4-5')
  })
})

// ============================================================================
// Faz 3 / #506 — OAuth (Claude subscription / Bearer) mode
// ============================================================================
//
// OAuth mode swaps `x-api-key` for a Bearer token, adds the Claude-Code beta
// + CLI identity headers Anthropic uses to route OAuth traffic, prepends a
// mandatory "You are Claude Code…" system block (without it Anthropic
// intermittently 500s OAuth requests), and reports `costUsd: 0` because usage
// goes against the Claude subscription, not an API budget.

describe('AnthropicLlmClient — OAuth mode', () => {
  function tokenProviderReturning(
    accessToken: string,
  ): () => Promise<{ accessToken: string; accountId?: string }> {
    return async () => ({ accessToken })
  }

  it('sends Bearer auth + Claude Code beta headers (no x-api-key)', async () => {
    const f = makeFetch([happyResponse()])
    const client = new AnthropicLlmClient({
      tokenProvider: tokenProviderReturning('sk-ant-oat01-FAKE'),
      model: 'claude-opus-4-7',
      fetchImpl: f.fetchImpl,
    })
    await client.call('hi', { feature: 'test', maxTokens: 16 })
    const headers = f.calls[0]!.init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer sk-ant-oat01-FAKE')
    expect(headers['x-api-key']).toBeUndefined()
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['anthropic-beta']).toContain('claude-code-20250219')
    expect(headers['anthropic-beta']).toContain('oauth-2025-04-20')
    expect(headers['user-agent']).toMatch(/^claude-cli\//)
    expect(headers['x-app']).toBe('cli')
  })

  it('prepends the mandatory Claude Code identity system block', async () => {
    const f = makeFetch([happyResponse()])
    const client = new AnthropicLlmClient({
      tokenProvider: tokenProviderReturning('sk-ant-oat01-x'),
      model: 'claude-opus-4-7',
      fetchImpl: f.fetchImpl,
    })
    await client.call('hi', { feature: 'test', maxTokens: 16 })
    const body = JSON.parse(String(f.calls[0]!.init.body)) as {
      system?: Array<{ type: string; text: string }>
    }
    expect(body.system).toEqual([
      {
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
    ])
  })

  it('reports costUsd = 0 (subscription, not API budget)', async () => {
    const f = makeFetch([happyResponse()])
    const client = new AnthropicLlmClient({
      tokenProvider: tokenProviderReturning('sk-ant-oat01-x'),
      model: 'claude-opus-4-7',
      fetchImpl: f.fetchImpl,
    })
    const res = await client.call('hi', { feature: 'test', maxTokens: 16 })
    expect(res.costUsd).toBe(0)
    // Tokens still recorded for usage telemetry.
    expect(res.inputTokens).toBe(8)
    expect(res.outputTokens).toBe(4)
  })

  it('calls tokenProvider on every request (so refresh hooks in)', async () => {
    const f = makeFetch([happyResponse(), happyResponse()])
    let calls = 0
    const tp = async () => {
      calls++
      return { accessToken: `tok-${calls}` }
    }
    const client = new AnthropicLlmClient({
      tokenProvider: tp,
      model: 'claude-opus-4-7',
      fetchImpl: f.fetchImpl,
    })
    await client.call('a', { feature: 'test', maxTokens: 16 })
    await client.call('b', { feature: 'test', maxTokens: 16 })
    expect(calls).toBe(2)
    expect(
      (f.calls[0]!.init.headers as Record<string, string>)['authorization'],
    ).toBe('Bearer tok-1')
    expect(
      (f.calls[1]!.init.headers as Record<string, string>)['authorization'],
    ).toBe('Bearer tok-2')
  })

  it('constructor throws when neither apiKey nor tokenProvider is given', () => {
    expect(
      () =>
        new AnthropicLlmClient({
          model: 'claude-opus-4-7',
          fetchImpl: vi.fn() as never,
        }),
    ).toThrow(/apiKey.*tokenProvider/)
  })

  it('API-key mode is bit-identical — no system block, x-api-key header', async () => {
    const f = makeFetch([happyResponse()])
    const client = new AnthropicLlmClient({
      apiKey: 'sk-ant-classic',
      model: 'claude-haiku-4-5',
      fetchImpl: f.fetchImpl,
    })
    await client.call('hi', { feature: 'test', maxTokens: 16 })
    const headers = f.calls[0]!.init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant-classic')
    expect(headers['authorization']).toBeUndefined()
    expect(headers['anthropic-beta']).toBeUndefined()
    const body = JSON.parse(String(f.calls[0]!.init.body)) as Record<
      string,
      unknown
    >
    expect(body.system).toBeUndefined()
  })
})
