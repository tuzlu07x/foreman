import { describe, expect, it } from 'vitest'
import type { ProviderEntry } from '../../src/core/registry-catalog.js'
import { configuredBrainProviderIds } from '../../src/tui/setup-wizard.js'

// =============================================================================
// #575 — Foreman's brain picker counts OAuth subscriptions, not just API keys
// =============================================================================
//
// A user with a ChatGPT or Claude subscription has no API-key secret slot, but
// `openai`+oauth routes to the Codex client and `anthropic`+oauth to the Claude
// subscription client (src/core/llm/factory.ts). The brain picker previously
// greyed those rows out. `configuredBrainProviderIds` fixes the gate by also
// counting (a) sign-ins chosen earlier this wizard run and (b) OAuth tokens
// already on disk (`llm-oauth-<provider>` slots).

function pe(overrides: Partial<ProviderEntry>): ProviderEntry {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    description: '',
    secret_name: 'anthropic-key',
    key_prefix: 'sk-ant-',
    where_to_get: null,
    format_hint: null,
    instructions: [],
    endpoint_default: null,
    endpoint_required: false,
    ...overrides,
  }
}

const PROVIDERS: ProviderEntry[] = [
  pe({ id: 'anthropic', name: 'Anthropic', secret_name: 'anthropic-key' }),
  pe({ id: 'openai', name: 'OpenAI', secret_name: 'openai-key' }),
  pe({ id: 'gemini', name: 'Google Gemini', secret_name: 'gemini-key' }),
]

describe('configuredBrainProviderIds', () => {
  it('counts a provider when its API key is stored', () => {
    const ids = configuredBrainProviderIds(
      PROVIDERS,
      new Set(['anthropic-key']),
      [],
    )
    expect(ids.has('anthropic')).toBe(true)
    expect(ids.has('openai')).toBe(false)
  })

  it('counts a subscription-only provider signed in earlier this run (no key)', () => {
    const ids = configuredBrainProviderIds(PROVIDERS, new Set(), ['openai'])
    expect(ids.has('openai')).toBe(true)
    expect(ids.has('anthropic')).toBe(false)
  })

  it('counts a provider with OAuth tokens already on disk (no key)', () => {
    // `foreman llm login anthropic` stores the bundle under llm-oauth-anthropic
    const ids = configuredBrainProviderIds(
      PROVIDERS,
      new Set(['llm-oauth-anthropic']),
      [],
    )
    expect(ids.has('anthropic')).toBe(true)
    expect(ids.has('openai')).toBe(false)
  })

  it('returns nothing when neither key nor OAuth is present', () => {
    const ids = configuredBrainProviderIds(PROVIDERS, new Set(), [])
    expect(ids.size).toBe(0)
  })

  it('merges API-key and subscription paths across providers', () => {
    const ids = configuredBrainProviderIds(
      PROVIDERS,
      new Set(['openai-key']),
      ['anthropic'],
    )
    expect(ids.has('openai')).toBe(true)
    expect(ids.has('anthropic')).toBe(true)
  })

  it('does not invent OAuth for non-OAuth providers (gemini is key-only)', () => {
    // gemini is not OAuth-capable — a stray llm-oauth-gemini slot must not
    // flip it on, and it only counts via its real key slot.
    const viaKey = configuredBrainProviderIds(
      PROVIDERS,
      new Set(['gemini-key']),
      [],
    )
    expect(viaKey.has('gemini')).toBe(true)

    const viaStrayOauth = configuredBrainProviderIds(
      PROVIDERS,
      new Set(['llm-oauth-gemini']),
      [],
    )
    expect(viaStrayOauth.has('gemini')).toBe(false)
  })
})
