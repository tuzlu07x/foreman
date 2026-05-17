import { describe, expect, it } from 'vitest'
import {
  buildLlmClient,
  LlmCredentialMissingError,
  LlmProviderUnavailableError,
} from '../../../src/core/llm/factory.js'
import { LlmConfigSchema, defaultLlmConfig } from '../../../src/core/llm/config.js'
import { SecretNotFoundError } from '../../../src/core/secret-store.js'
import { AnthropicLlmClient } from '../../../src/core/llm/providers/anthropic.js'
import { OpenAILlmClient } from '../../../src/core/llm/providers/openai.js'
import { GeminiLlmClient } from '../../../src/core/llm/providers/gemini.js'

// =============================================================================
// Tests pin the factory's contract: every implemented provider returns the
// right concrete class with its secret resolved; unimplemented providers
// throw LlmProviderUnavailableError; missing/empty secrets throw
// LlmCredentialMissingError (typed, not raw).
//
// Uses a fake store so we don't touch the real DB / master key.
// =============================================================================

class FakeStore {
  private readonly map = new Map<string, string>()
  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.map.set(k, v)
  }
  get(name: string): string {
    if (!this.map.has(name)) throw new SecretNotFoundError(name)
    return this.map.get(name)!
  }
  // The factory only calls .get — the rest of SecretStore's surface area is
  // unused, so a structural mock is enough.
}

describe('buildLlmClient', () => {
  it('returns an AnthropicLlmClient for provider=anthropic', () => {
    const config = LlmConfigSchema.parse({
      provider: 'anthropic',
      credentials: { anthropic: { secret_name: 'anthropic-key' } },
    })
    const store = new FakeStore({ 'anthropic-key': 'sk-ant-test' })
    const client = buildLlmClient(config, store as never)
    expect(client).toBeInstanceOf(AnthropicLlmClient)
    expect(client.providerId).toBe('anthropic')
    expect(client.model).toBe(config.model)
  })

  it('returns an OpenAILlmClient for provider=openai', () => {
    const config = LlmConfigSchema.parse({
      provider: 'openai',
      model: 'gpt-4o-mini',
      credentials: { openai: { secret_name: 'openai-key' } },
    })
    const store = new FakeStore({ 'openai-key': 'sk-proj-test' })
    const client = buildLlmClient(config, store as never)
    expect(client).toBeInstanceOf(OpenAILlmClient)
    expect(client.providerId).toBe('openai')
    expect(client.model).toBe('gpt-4o-mini')
  })

  it('returns a GeminiLlmClient for provider=gemini', () => {
    const config = LlmConfigSchema.parse({
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      credentials: { gemini: { secret_name: 'gemini-key' } },
    })
    const store = new FakeStore({ 'gemini-key': 'AIza-test' })
    const client = buildLlmClient(config, store as never)
    expect(client).toBeInstanceOf(GeminiLlmClient)
    expect(client.providerId).toBe('gemini')
  })

  it('throws LlmProviderUnavailableError for provider=ollama (not yet implemented)', () => {
    const config = LlmConfigSchema.parse({ provider: 'ollama' })
    const store = new FakeStore({})
    expect(() => buildLlmClient(config, store as never)).toThrow(
      LlmProviderUnavailableError,
    )
  })

  it('throws LlmProviderUnavailableError for provider=openai_compatible (not yet implemented)', () => {
    const config = LlmConfigSchema.parse({ provider: 'openai_compatible' })
    const store = new FakeStore({})
    expect(() => buildLlmClient(config, store as never)).toThrow(
      LlmProviderUnavailableError,
    )
  })

  it('LlmProviderUnavailableError message lists the supported providers', () => {
    const config = LlmConfigSchema.parse({ provider: 'ollama' })
    try {
      buildLlmClient(config, new FakeStore({}) as never)
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(LlmProviderUnavailableError)
      expect((err as Error).message).toMatch(/anthropic, openai, gemini/)
    }
  })

  it('throws LlmCredentialMissingError when secret_name is unset', () => {
    const config = LlmConfigSchema.parse({
      provider: 'openai',
      // No openai credential block at all
      credentials: {},
    })
    expect(() =>
      buildLlmClient(config, new FakeStore({}) as never),
    ).toThrow(LlmCredentialMissingError)
  })

  it('throws LlmCredentialMissingError when secret_name is explicitly null', () => {
    const config = LlmConfigSchema.parse({
      provider: 'anthropic',
      credentials: { anthropic: { secret_name: null } },
    })
    expect(() =>
      buildLlmClient(config, new FakeStore({}) as never),
    ).toThrow(LlmCredentialMissingError)
  })

  it('throws LlmCredentialMissingError when secret is configured but missing from store', () => {
    const config = LlmConfigSchema.parse({
      provider: 'openai',
      credentials: { openai: { secret_name: 'openai-key' } },
    })
    expect(() =>
      buildLlmClient(config, new FakeStore({}) as never),
    ).toThrow(LlmCredentialMissingError)
  })

  it('LlmCredentialMissingError surfaces the `foreman secrets add X` hint', () => {
    const config = LlmConfigSchema.parse({
      provider: 'openai',
      credentials: { openai: { secret_name: 'my-openai-key' } },
    })
    try {
      buildLlmClient(config, new FakeStore({}) as never)
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(LlmCredentialMissingError)
      expect((err as Error).message).toMatch(
        /foreman secrets add my-openai-key/,
      )
    }
  })

  it('uses defaultLlmConfig credentials when user did not override', () => {
    const config = defaultLlmConfig()
    config.provider = 'anthropic'
    // defaultLlmConfig populates credentials.anthropic.secret_name = 'anthropic-key'
    const store = new FakeStore({ 'anthropic-key': 'sk-ant' })
    const client = buildLlmClient(config, store as never)
    expect(client.providerId).toBe('anthropic')
  })

  it('factory is sync — caller need not await', () => {
    const config = LlmConfigSchema.parse({
      provider: 'anthropic',
      credentials: { anthropic: { secret_name: 'anthropic-key' } },
    })
    const store = new FakeStore({ 'anthropic-key': 'sk-ant' })
    const result = buildLlmClient(config, store as never)
    // Not a Promise — verifying contract.
    expect(typeof (result as { then?: unknown }).then).toBe('undefined')
  })
})

describe('LlmCredentialMissingError + LlmProviderUnavailableError — typed', () => {
  it('LlmCredentialMissingError carries providerId + secretName for callers to render', () => {
    const err = new LlmCredentialMissingError('openai', 'my-key')
    expect(err.providerId).toBe('openai')
    expect(err.secretName).toBe('my-key')
    expect(err.name).toBe('LlmCredentialMissingError')
  })

  it('LlmCredentialMissingError with null secretName surfaces the "unset in llm.yaml" message', () => {
    const err = new LlmCredentialMissingError('gemini', null)
    expect(err.message).toMatch(/no secret_name configured/)
  })

  it('LlmProviderUnavailableError carries the provider id', () => {
    const err = new LlmProviderUnavailableError('ollama')
    expect(err.providerId).toBe('ollama')
    expect(err.name).toBe('LlmProviderUnavailableError')
  })
})
