import { describe, expect, it } from 'vitest'
import {
  buildLlmClient,
  LlmCredentialMissingError,
  LlmOAuthLoginRequiredError,
  LlmProviderUnavailableError,
} from '../../../src/core/llm/factory.js'
import { LlmConfigSchema, defaultLlmConfig } from '../../../src/core/llm/config.js'
import { SecretNotFoundError } from '../../../src/core/secret-store.js'
import { AnthropicLlmClient } from '../../../src/core/llm/providers/anthropic.js'
import { CodexLlmClient } from '../../../src/core/llm/providers/codex.js'
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

  // ---------- Faz 2 / #505 — `auth_mode: oauth` dispatch ----------

  /** A valid OAuth bundle keyed under the slot `token-store.ts` reads from
   *  (`llm-oauth-<provider>`). Far-future expiry so refresh isn't triggered. */
  function seedOAuthTokens(
    providerId: 'anthropic' | 'openai',
  ): Record<string, string> {
    return {
      [`llm-oauth-${providerId}`]: JSON.stringify({
        accessToken: 'A',
        refreshToken: 'R',
        expiresAt: Date.now() + 60 * 60_000,
        ...(providerId === 'openai' ? { accountId: 'acc-1' } : {}),
      }),
    }
  }

  it('returns an OAuth-aware AnthropicLlmClient when auth_mode = oauth', () => {
    const config = LlmConfigSchema.parse({
      provider: 'anthropic',
      credentials: { anthropic: { auth_mode: 'oauth' } },
    })
    const store = new FakeStore(seedOAuthTokens('anthropic'))
    const client = buildLlmClient(config, store as never)
    expect(client).toBeInstanceOf(AnthropicLlmClient)
    expect(client.providerId).toBe('anthropic')
    expect(client.model).toBe(config.model)
  })

  it('returns a CodexLlmClient when openai auth_mode = oauth', () => {
    const config = LlmConfigSchema.parse({
      provider: 'openai',
      model: 'gpt-5.4',
      credentials: { openai: { auth_mode: 'oauth' } },
    })
    const store = new FakeStore(seedOAuthTokens('openai'))
    const client = buildLlmClient(config, store as never)
    expect(client).toBeInstanceOf(CodexLlmClient)
    // Same logical provider id as the API-key OpenAI client — disambiguated
    // by auth_mode in the factory, not by providerId downstream.
    expect(client.providerId).toBe('openai')
    expect(client.model).toBe('gpt-5.4')
  })

  it('throws LlmOAuthLoginRequiredError when auth_mode = oauth but no tokens stored', () => {
    const config = LlmConfigSchema.parse({
      provider: 'anthropic',
      credentials: { anthropic: { auth_mode: 'oauth' } },
    })
    expect(() =>
      buildLlmClient(config, new FakeStore({}) as never),
    ).toThrow(LlmOAuthLoginRequiredError)
  })

  it('LlmOAuthLoginRequiredError points the user at `foreman llm login <provider>`', () => {
    const config = LlmConfigSchema.parse({
      provider: 'openai',
      credentials: { openai: { auth_mode: 'oauth' } },
    })
    try {
      buildLlmClient(config, new FakeStore({}) as never)
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(LlmOAuthLoginRequiredError)
      expect((err as Error).message).toMatch(/foreman llm login openai/)
    }
  })

  it('api-key path is bit-identical when auth_mode is explicitly api_key', () => {
    const config = LlmConfigSchema.parse({
      provider: 'anthropic',
      credentials: {
        anthropic: { auth_mode: 'api_key', secret_name: 'anthropic-key' },
      },
    })
    const store = new FakeStore({ 'anthropic-key': 'sk-ant' })
    const client = buildLlmClient(config, store as never)
    expect(client.providerId).toBe('anthropic')
  })

  it('gemini ignores auth_mode = oauth (no subscription-OAuth equivalent today)', () => {
    const config = LlmConfigSchema.parse({
      provider: 'gemini',
      credentials: {
        gemini: { auth_mode: 'oauth', secret_name: 'gemini-key' },
      },
    })
    const store = new FakeStore({ 'gemini-key': 'AIza' })
    // No OAuth dispatch — falls through to API-key path.
    const client = buildLlmClient(config, store as never)
    expect(client.providerId).toBe('gemini')
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

  it('LlmOAuthLoginRequiredError carries the OAuth provider id', () => {
    const err = new LlmOAuthLoginRequiredError('anthropic')
    expect(err.providerId).toBe('anthropic')
    expect(err.name).toBe('LlmOAuthLoginRequiredError')
    expect(err.message).toMatch(/foreman llm login anthropic/)
  })

})
