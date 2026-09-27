import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearModelsDiscoveryCache,
  discoverModels,
  listAnthropicModels,
  ModelDiscoveryError,
} from '../../src/core/llm/models-discovery.js'

// =============================================================================
// Subscription sign-in model discovery (#575 follow-up). A Claude sign-in
// token lists models with the same Bearer + beta headers the OAuth messages
// client sends; ChatGPT sign-in tokens have no listable endpoint.
// =============================================================================

beforeEach(() => {
  clearModelsDiscoveryCache()
})

function recordingFetch(): { fetchImpl: typeof fetch; headers: () => Record<string, string> } {
  let seen: Record<string, string> = {}
  const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    seen = { ...(init?.headers as Record<string, string>) }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'claude-fake-1', display_name: 'Claude Fake' }] }),
      text: async () => '',
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, headers: () => seen }
}

describe('listAnthropicModels with a subscription token', () => {
  it('sends Bearer + the oauth beta header instead of x-api-key', async () => {
    const { fetchImpl, headers } = recordingFetch()
    const models = await listAnthropicModels({
      apiKey: 'fake-oauth-access-token',
      auth: 'oauth',
      fetchImpl,
    })
    expect(models.map((m) => m.id)).toEqual(['claude-fake-1'])
    expect(headers().authorization).toBe('Bearer fake-oauth-access-token')
    expect(headers()['anthropic-beta']).toContain('oauth-2025-04-20')
    expect(headers()['x-api-key']).toBeUndefined()
  })

  it('keeps the x-api-key header for API keys', async () => {
    const { fetchImpl, headers } = recordingFetch()
    await listAnthropicModels({ apiKey: 'sk-ant-fake', fetchImpl })
    expect(headers()['x-api-key']).toBe('sk-ant-fake')
    expect(headers().authorization).toBeUndefined()
  })
})

describe('discoverModels with auth: oauth', () => {
  it('lists Anthropic models', async () => {
    const { fetchImpl } = recordingFetch()
    const models = await discoverModels('anthropic', {
      apiKey: 'fake-oauth-access-token',
      auth: 'oauth',
      fetchImpl,
    })
    expect(models).toHaveLength(1)
  })

  it('rejects providers whose sign-in has no model list, without a request', async () => {
    const { fetchImpl } = recordingFetch()
    await expect(
      discoverModels('openai', { apiKey: 'fake', auth: 'oauth', fetchImpl }),
    ).rejects.toBeInstanceOf(ModelDiscoveryError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not share a cache entry between an API key and a token with the same text', async () => {
    const { fetchImpl } = recordingFetch()
    await discoverModels('anthropic', { apiKey: 'same-text', fetchImpl })
    await discoverModels('anthropic', { apiKey: 'same-text', auth: 'oauth', fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
