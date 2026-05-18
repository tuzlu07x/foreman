import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearModelsDiscoveryCache,
  discoverModels,
  listAnthropicModels,
  listGeminiModels,
  listOpenAiModels,
  ModelDiscoveryError,
} from '../../src/core/llm/models-discovery.js'

// =============================================================================
// #399 — Live model discovery per provider. Uses injectable `fetchImpl` so we
// can stub responses without hitting the real APIs.
// =============================================================================

function mockFetch(
  responses: Record<string, { ok: boolean; status: number; body: unknown }>,
): typeof fetch {
  return (async (url: string | URL) => {
    const key = typeof url === 'string' ? url : url.toString()
    // Match on hostname+path so query strings (Gemini's `?key=`) don't break
    // dispatch. Pull the base url out before the query string.
    const baseKey = key.split('?')[0]!
    const match =
      responses[key] ??
      responses[baseKey] ??
      Object.entries(responses).find(([k]) => key.startsWith(k))?.[1]
    if (!match) {
      throw new Error(`mockFetch: no response for ${key}`)
    }
    return {
      ok: match.ok,
      status: match.status,
      json: async () => match.body,
      text: async () => JSON.stringify(match.body),
    } as unknown as Response
  }) as unknown as typeof fetch
}

beforeEach(() => {
  clearModelsDiscoveryCache()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('listOpenAiModels', () => {
  it('filters /v1/models to chat-completion-capable ids', async () => {
    const fetchImpl = mockFetch({
      'https://api.openai.com/v1/models': {
        ok: true,
        status: 200,
        body: {
          data: [
            { id: 'gpt-4o-mini' },
            { id: 'gpt-5.4' },
            { id: 'gpt-3.5-turbo' },
            { id: 'text-embedding-3-small' }, // embedding, must be filtered
            { id: 'whisper-1' }, // audio, must be filtered
            { id: 'dall-e-3' }, // image, must be filtered
            { id: 'tts-1' }, // tts, must be filtered
            { id: 'o3-mini' }, // o-series chat
          ],
        },
      },
    })
    const models = await listOpenAiModels({ apiKey: 'sk-test', fetchImpl })
    const ids = models.map((m) => m.id)
    expect(ids).toContain('gpt-4o-mini')
    expect(ids).toContain('gpt-5.4')
    expect(ids).toContain('o3-mini')
    expect(ids).not.toContain('text-embedding-3-small')
    expect(ids).not.toContain('whisper-1')
    expect(ids).not.toContain('dall-e-3')
    expect(ids).not.toContain('tts-1')
  })

  it('formats each result with slash_id and family', async () => {
    const fetchImpl = mockFetch({
      'https://api.openai.com/v1/models': {
        ok: true,
        status: 200,
        body: { data: [{ id: 'gpt-4o-mini' }] },
      },
    })
    const models = await listOpenAiModels({ apiKey: 'sk-test', fetchImpl })
    expect(models[0]?.slash_id).toBe('openai/gpt-4o-mini')
    expect(models[0]?.family).toBe('gpt-4')
  })

  it('throws ModelDiscoveryError on non-2xx', async () => {
    const fetchImpl = mockFetch({
      'https://api.openai.com/v1/models': {
        ok: false,
        status: 401,
        body: { error: 'invalid api key' },
      },
    })
    await expect(
      listOpenAiModels({ apiKey: 'bad', fetchImpl }),
    ).rejects.toBeInstanceOf(ModelDiscoveryError)
  })
})

describe('listAnthropicModels', () => {
  it('returns claude ids with display_name labels', async () => {
    const fetchImpl = mockFetch({
      'https://api.anthropic.com/v1/models': {
        ok: true,
        status: 200,
        body: {
          data: [
            {
              id: 'claude-opus-4-7-20250101',
              display_name: 'Claude Opus 4.7',
            },
            { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' },
          ],
        },
      },
    })
    const models = await listAnthropicModels({ apiKey: 'sk-ant', fetchImpl })
    expect(models).toHaveLength(2)
    expect(models[0]?.slash_id).toMatch(/^anthropic\//)
    const haiku = models.find((m) => m.id === 'claude-haiku-4-5-20251001')
    expect(haiku?.label).toBe('Claude Haiku 4.5')
    expect(haiku?.slash_id).toBe('anthropic/claude-haiku-4-5-20251001')
    expect(haiku?.family).toBe('claude-haiku-4')
  })
})

describe('listGeminiModels', () => {
  it('strips the "models/" prefix and filters to generateContent-capable', async () => {
    const fetchImpl = mockFetch({
      'https://generativelanguage.googleapis.com/v1beta/models': {
        ok: true,
        status: 200,
        body: {
          models: [
            {
              name: 'models/gemini-2.5-flash',
              displayName: 'Gemini 2.5 Flash',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/gemini-3-pro-preview',
              displayName: 'Gemini 3 Pro Preview',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/text-embedding-004',
              displayName: 'Text Embedding 004',
              supportedGenerationMethods: ['embedContent'], // not chat
            },
          ],
        },
      },
    })
    const models = await listGeminiModels({
      apiKey: 'AIzaSyTEST',
      fetchImpl,
    })
    const ids = models.map((m) => m.id)
    expect(ids).toContain('gemini-2.5-flash')
    expect(ids).toContain('gemini-3-pro-preview')
    expect(ids).not.toContain('text-embedding-004')
    const flash = models.find((m) => m.id === 'gemini-2.5-flash')
    expect(flash?.slash_id).toBe('google/gemini-2.5-flash')
    expect(flash?.family).toBe('gemini-2.5')
  })
})

describe('discoverModels — dispatcher + cache', () => {
  it('routes to the correct provider', async () => {
    const fetchImpl = mockFetch({
      'https://api.openai.com/v1/models': {
        ok: true,
        status: 200,
        body: { data: [{ id: 'gpt-4o-mini' }] },
      },
    })
    const result = await discoverModels('openai', {
      apiKey: 'sk-test',
      fetchImpl,
    })
    expect(result[0]?.id).toBe('gpt-4o-mini')
  })

  it('caches results per (provider, key) and serves the cached copy on re-call', async () => {
    let fetchCalls = 0
    const fetchImpl = (async (url: string | URL) => {
      fetchCalls++
      const u = typeof url === 'string' ? url : url.toString()
      if (u.startsWith('https://api.openai.com/v1/models')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 'gpt-4o-mini' }] }),
          text: async () => '',
        } as unknown as Response
      }
      throw new Error('unexpected ' + u)
    }) as unknown as typeof fetch
    await discoverModels('openai', { apiKey: 'sk-1', fetchImpl })
    await discoverModels('openai', { apiKey: 'sk-1', fetchImpl })
    await discoverModels('openai', { apiKey: 'sk-1', fetchImpl })
    expect(fetchCalls).toBe(1)
  })

  it('treats different api keys as distinct cache entries', async () => {
    let fetchCalls = 0
    const fetchImpl = (async () => {
      fetchCalls++
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'gpt-4o-mini' }] }),
        text: async () => '',
      } as unknown as Response
    }) as unknown as typeof fetch
    await discoverModels('openai', { apiKey: 'sk-1', fetchImpl })
    await discoverModels('openai', { apiKey: 'sk-2', fetchImpl })
    expect(fetchCalls).toBe(2)
  })

  it('respects cacheTtlMs=0 (always re-fetch)', async () => {
    let fetchCalls = 0
    const fetchImpl = (async () => {
      fetchCalls++
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'gpt-4o-mini' }] }),
        text: async () => '',
      } as unknown as Response
    }) as unknown as typeof fetch
    await discoverModels('openai', {
      apiKey: 'sk-1',
      fetchImpl,
      cacheTtlMs: 0,
    })
    await discoverModels('openai', {
      apiKey: 'sk-1',
      fetchImpl,
      cacheTtlMs: 0,
    })
    expect(fetchCalls).toBe(2)
  })

  it('expires cache after the configured TTL', async () => {
    let fetchCalls = 0
    let nowMs = 1_000_000
    const fetchImpl = (async () => {
      fetchCalls++
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'gpt-4o-mini' }] }),
        text: async () => '',
      } as unknown as Response
    }) as unknown as typeof fetch
    const opts = {
      apiKey: 'sk-1',
      fetchImpl,
      cacheTtlMs: 1000,
      now: () => nowMs,
    }
    await discoverModels('openai', opts)
    nowMs += 500 // still within TTL
    await discoverModels('openai', opts)
    expect(fetchCalls).toBe(1)
    nowMs += 1500 // past TTL
    await discoverModels('openai', opts)
    expect(fetchCalls).toBe(2)
  })

  it('rejects unknown provider strings', async () => {
    await expect(
      // @ts-expect-error testing runtime validation of an out-of-union string
      discoverModels('cohere', { apiKey: 'k' }),
    ).rejects.toThrow(/Unknown discovery provider/)
  })
})
