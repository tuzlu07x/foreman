import { describe, expect, it } from 'vitest'
import { defaultLlmConfig } from '../../src/core/llm/config.js'
import type { ProviderEntry } from '../../src/core/registry-catalog.js'
import { buildLlmConfigFromWizard } from '../../src/tui/setup-wizard-llm-persist.js'

// =============================================================================
// Pure-logic tests for #289 — wizard → llm.yaml persistence
// =============================================================================
//
// The bug: setup wizard collected provider keys and stored them in the secret
// vault but never wrote llm.yaml. The runtime then ran with LLM disabled and
// every "I configured Anthropic in setup" expectation broke silently.
//
// These tests pin the contract for the pure function that bridges
// "wizard saved these storage names" → "this is the llm.yaml that should
// land on disk".

function entry(overrides: Partial<ProviderEntry>): ProviderEntry {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'desc',
    secret_name: 'anthropic-api-key',
    where_to_get: null,
    format_hint: null,
    instructions: [],
    endpoint_default: null,
    endpoint_required: false,
    ...overrides,
  }
}

const CATALOG: ProviderEntry[] = [
  entry({ id: 'anthropic', secret_name: 'anthropic-api-key' }),
  entry({ id: 'openai', secret_name: 'openai-api-key' }),
  entry({ id: 'gemini', secret_name: 'gemini-api-key' }),
  entry({
    id: 'ollama',
    secret_name: null,
    endpoint_default: 'http://localhost:11434',
    endpoint_required: true,
  }),
  entry({
    id: 'custom',
    secret_name: 'openai-compatible-api-key',
    endpoint_default: null,
    endpoint_required: true,
  }),
]

describe('buildLlmConfigFromWizard — happy path', () => {
  it('wires a single anthropic save into credentials + flips enabled on', () => {
    const result = buildLlmConfigFromWizard({
      savedStorageNames: ['anthropic-api-key'],
      providerCatalog: CATALOG,
      existing: defaultLlmConfig(),
    })
    expect(result.wiredProviders).toEqual(['anthropic'])
    expect(result.next.enabled).toBe(true)
    expect(result.next.provider).toBe('anthropic')
    expect(result.next.credentials.anthropic?.secret_name).toBe(
      'anthropic-api-key',
    )
  })

  it('turns verification + smart_report on so the LLM features actually fire', () => {
    const result = buildLlmConfigFromWizard({
      savedStorageNames: ['anthropic-api-key'],
      providerCatalog: CATALOG,
      existing: defaultLlmConfig(),
    })
    expect(result.next.features.verification).toBe(true)
    expect(result.next.features.smart_report).toBe(true)
  })

  it('picks the FIRST saved provider as the default when multiple are wired', () => {
    const result = buildLlmConfigFromWizard({
      savedStorageNames: ['openai-api-key', 'anthropic-api-key', 'gemini-api-key'],
      providerCatalog: CATALOG,
      existing: defaultLlmConfig(),
    })
    expect(result.wiredProviders).toEqual(['openai', 'anthropic', 'gemini'])
    expect(result.next.provider).toBe('openai')
    expect(result.next.credentials.openai?.secret_name).toBe('openai-api-key')
    expect(result.next.credentials.anthropic?.secret_name).toBe(
      'anthropic-api-key',
    )
    expect(result.next.credentials.gemini?.secret_name).toBe('gemini-api-key')
  })

  it('wires ollama via endpoint_secret when only the endpoint was stored', () => {
    const result = buildLlmConfigFromWizard({
      savedStorageNames: ['ollama-endpoint'],
      providerCatalog: CATALOG,
      existing: defaultLlmConfig(),
    })
    expect(result.wiredProviders).toEqual(['ollama'])
    expect(result.next.provider).toBe('ollama')
    expect(result.next.credentials.ollama?.endpoint_secret).toBe(
      'ollama-endpoint',
    )
  })

  it('wires openai_compatible via custom catalog entry (endpoint + key)', () => {
    const result = buildLlmConfigFromWizard({
      savedStorageNames: ['custom-endpoint', 'openai-compatible-api-key'],
      providerCatalog: CATALOG,
      existing: defaultLlmConfig(),
    })
    expect(result.wiredProviders).toEqual(['openai_compatible'])
    expect(result.next.credentials.openai_compatible?.endpoint_secret).toBe(
      'custom-endpoint',
    )
    expect(result.next.credentials.openai_compatible?.secret_name).toBe(
      'openai-compatible-api-key',
    )
  })
})

describe('buildLlmConfigFromWizard — no-op / edge cases', () => {
  it('returns existing config unchanged when wizard saved nothing', () => {
    const existing = defaultLlmConfig()
    const result = buildLlmConfigFromWizard({
      savedStorageNames: [],
      providerCatalog: CATALOG,
      existing,
    })
    expect(result.wiredProviders).toEqual([])
    expect(result.next).toBe(existing) // pointer identity — no copy
  })

  it('ignores storage names that do not match any catalog entry', () => {
    const result = buildLlmConfigFromWizard({
      savedStorageNames: ['ghost-key', 'anthropic-api-key', 'made-up'],
      providerCatalog: CATALOG,
      existing: defaultLlmConfig(),
    })
    expect(result.wiredProviders).toEqual(['anthropic'])
  })

  it('deduplicates providers when both secret + endpoint were saved', () => {
    const result = buildLlmConfigFromWizard({
      savedStorageNames: ['custom-endpoint', 'openai-compatible-api-key'],
      providerCatalog: CATALOG,
      existing: defaultLlmConfig(),
    })
    expect(result.wiredProviders).toEqual(['openai_compatible'])
  })
})

describe('buildLlmConfigFromWizard — merge semantics', () => {
  it("preserves the existing model when user has manually overridden it", () => {
    const existing = defaultLlmConfig()
    existing.model = 'claude-sonnet-4-6'
    existing.budget.monthly_cap_usd = 99
    const result = buildLlmConfigFromWizard({
      savedStorageNames: ['anthropic-api-key'],
      providerCatalog: CATALOG,
      existing,
    })
    expect(result.next.model).toBe('claude-sonnet-4-6')
    expect(result.next.budget.monthly_cap_usd).toBe(99)
  })

  it('preserves existing credentials for providers the wizard did NOT touch', () => {
    const existing = defaultLlmConfig()
    existing.credentials.gemini = { secret_name: 'my-custom-gemini-slot' }
    const result = buildLlmConfigFromWizard({
      savedStorageNames: ['anthropic-api-key'],
      providerCatalog: CATALOG,
      existing,
    })
    // Wizard wrote anthropic; gemini's user override survives
    expect(result.next.credentials.gemini?.secret_name).toBe(
      'my-custom-gemini-slot',
    )
    expect(result.next.credentials.anthropic?.secret_name).toBe(
      'anthropic-api-key',
    )
  })

  it("does not flip enabled / provider when nothing was saved", () => {
    const existing = defaultLlmConfig()
    existing.enabled = false
    existing.provider = 'anthropic'
    const result = buildLlmConfigFromWizard({
      savedStorageNames: [],
      providerCatalog: CATALOG,
      existing,
    })
    expect(result.next.enabled).toBe(false)
    expect(result.next.provider).toBe('anthropic')
  })
})
