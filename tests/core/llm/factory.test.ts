import { describe, expect, it } from 'vitest'
import {
  buildLlmClient,
  LlmCredentialMissingError,
  LlmEndpointError,
  LlmOAuthLoginRequiredError,
  LlmProviderUnavailableError,
} from '../../../src/core/llm/factory.js'
import { LlmConfigSchema, defaultLlmConfig } from '../../../src/core/llm/config.js'
import { SecretNotFoundError } from '../../../src/core/secret-store.js'
import { AnthropicLlmClient } from '../../../src/core/llm/providers/anthropic.js'
import { CodexLlmClient } from '../../../src/core/llm/providers/codex.js'
import { OpenAILlmClient } from '../../../src/core/llm/providers/openai.js'
import { GeminiLlmClient } from '../../../src/core/llm/providers/gemini.js'
import { OpenAICompatibleLlmClient } from '../../../src/core/llm/providers/openai-compatible.js'

// =============================================================================
// Tests pin the factory's contract: every implemented provider returns the
// right concrete class with its secret resolved; missing/empty secrets
// throw LlmCredentialMissingError (typed, not raw), and a missing or
// invalid self-hosted base URL throws its LlmEndpointError subclass.
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

  it('returns a keyless Ollama client on the default local URL', () => {
    const config = LlmConfigSchema.parse({ provider: 'ollama', model: 'llama3.2:3b' })
    const client = buildLlmClient(config, new FakeStore({}) as never)
    expect(client).toBeInstanceOf(OpenAICompatibleLlmClient)
    expect(client.providerId).toBe('ollama')
    expect(client.model).toBe('llama3.2:3b')
    expect(Reflect.get(client, 'baseUrl')).toBe('http://localhost:11434/v1')
    expect(Reflect.get(client, 'apiKey')).toBeNull()
  })

  it('reads the Ollama URL from endpoint_secret before endpoint, and a key from secret_name', () => {
    const config = LlmConfigSchema.parse({
      provider: 'ollama',
      credentials: {
        ollama: {
          endpoint: 'http://localhost:11434',
          endpoint_secret: 'ollama-endpoint',
          secret_name: 'ollama-key',
        },
      },
    })
    const store = new FakeStore({
      'ollama-endpoint': 'https://ollama.example.test/v1/',
      'ollama-key': 'fake-ollama-key',
    })
    const client = buildLlmClient(config, store as never)
    expect(Reflect.get(client, 'baseUrl')).toBe('https://ollama.example.test/v1')
    expect(Reflect.get(client, 'apiKey')).toBe('fake-ollama-key')
  })

  it('builds an openai_compatible client from a preset-style block', () => {
    const config = LlmConfigSchema.parse({
      provider: 'openai_compatible',
      model: 'deepseek-chat',
      credentials: {
        openai_compatible: {
          endpoint_secret: 'deepseek-endpoint',
          key_secret: 'deepseek-api-key',
        },
      },
    })
    const store = new FakeStore({
      'deepseek-endpoint': 'https://api.deepseek.example.test/v1',
      'deepseek-api-key': 'fake-deepseek-key',
    })
    const client = buildLlmClient(config, store as never)
    expect(client).toBeInstanceOf(OpenAICompatibleLlmClient)
    expect(client.providerId).toBe('openai_compatible')
    expect(Reflect.get(client, 'baseUrl')).toBe('https://api.deepseek.example.test/v1')
    expect(Reflect.get(client, 'apiKey')).toBe('fake-deepseek-key')
  })

  it('builds a keyless openai_compatible client when no key slot is named', () => {
    const config = LlmConfigSchema.parse({
      provider: 'openai_compatible',
      model: 'local-model',
      credentials: { openai_compatible: { endpoint: 'http://127.0.0.1:8000/v1' } },
    })
    const client = buildLlmClient(config, new FakeStore({}) as never)
    expect(Reflect.get(client, 'apiKey')).toBeNull()
  })

  it('throws LlmCredentialMissingError when a named openai_compatible key is missing', () => {
    const config = LlmConfigSchema.parse({
      provider: 'openai_compatible',
      credentials: {
        openai_compatible: { endpoint: 'https://x.example.test/v1', key_secret: 'gone-key' },
      },
    })
    try {
      buildLlmClient(config, new FakeStore({}) as never)
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(LlmCredentialMissingError)
      expect(err).not.toBeInstanceOf(LlmEndpointError)
      expect((err as LlmCredentialMissingError).secretName).toBe('gone-key')
    }
  })

  it('throws LlmEndpointError (a LlmCredentialMissingError) for openai_compatible without a URL', () => {
    const config = LlmConfigSchema.parse({
      provider: 'openai_compatible',
      credentials: { openai_compatible: {} },
    })
    const build = (): unknown => buildLlmClient(config, new FakeStore({}) as never)
    expect(build).toThrow(LlmEndpointError)
    expect(build).toThrow(LlmCredentialMissingError)
    expect(build).toThrow(/no base URL configured/)
  })

  it('throws LlmEndpointError when the endpoint secret is missing from the store', () => {
    // The schema default for openai_compatible names openai-compatible-endpoint.
    const config = defaultLlmConfig()
    config.provider = 'openai_compatible'
    expect(() => buildLlmClient(config, new FakeStore({}) as never)).toThrow(
      /secret 'openai-compatible-endpoint' is not in the store/,
    )
  })

  it.each([
    ['file:///etc/passwd', /not allowed/],
    ['ftp://host/v1', /not allowed/],
    ['http://user:pass@host/v1', /username or password/],
    ['https://host/v1?key=x', /query string/],
    ['not a url', /not a valid URL/],
  ])('rejects the base URL %s', (url, reason) => {
    const config = LlmConfigSchema.parse({
      provider: 'openai_compatible',
      credentials: { openai_compatible: { endpoint: url } },
    })
    const build = (): unknown => buildLlmClient(config, new FakeStore({}) as never)
    expect(build).toThrow(LlmEndpointError)
    expect(build).toThrow(reason)
  })

  it('never echoes a stored endpoint value in the error', () => {
    const config = LlmConfigSchema.parse({
      provider: 'ollama',
      credentials: { ollama: { endpoint_secret: 'ollama-endpoint' } },
    })
    const store = new FakeStore({ 'ollama-endpoint': 'sk-pasted-in-the-wrong-slot' })
    try {
      buildLlmClient(config, store as never)
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(LlmEndpointError)
      expect((err as Error).message).not.toContain('sk-pasted-in-the-wrong-slot')
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
