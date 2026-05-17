import { describe, expect, it } from 'vitest'
import type { ProviderEntry } from '../../src/core/registry-catalog.js'
import { validateKeyPaste } from '../../src/tui/setup-wizard-key-validation.js'

// =============================================================================
// Pure-logic tests for #291 — paste-time key prefix validation
// =============================================================================
//
// The bug: user pasted an OpenAI sk-proj-… key into the Anthropic key slot
// during the wizard. Silent save → confusing 401 hours later when
// `foreman llm test` ran. This validator catches that moment by checking
// the pasted value against the catalog's expected prefix.
//
// Three contract rules pinned here:
//   1. Warn, don't reject (return ok=false but caller still saves).
//   2. Opt-out via key_prefix: null (Ollama, custom).
//   3. Cross-provider detection — call out which provider it looks like.

function entry(overrides: Partial<ProviderEntry>): ProviderEntry {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'desc',
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

const ANTHROPIC = entry({
  id: 'anthropic',
  name: 'Anthropic',
  secret_name: 'anthropic-key',
  key_prefix: 'sk-ant-',
})

const OPENAI = entry({
  id: 'openai',
  name: 'OpenAI',
  secret_name: 'openai-key',
  key_prefix: 'sk-',
})

const GEMINI = entry({
  id: 'gemini',
  name: 'Google Gemini',
  secret_name: 'gemini-key',
  key_prefix: 'AIza',
})

const OLLAMA = entry({
  id: 'ollama',
  name: 'Local (Ollama)',
  secret_name: null,
  key_prefix: null,
})

const CUSTOM = entry({
  id: 'openai-compatible',
  name: 'Custom OpenAI-compatible',
  secret_name: 'openai-compatible-key',
  key_prefix: null,
})

describe('validateKeyPaste — happy path (prefix matches)', () => {
  it.each([
    [ANTHROPIC, 'sk-ant-api03-abc123def456'],
    [OPENAI, 'sk-proj-xyz789'],
    [OPENAI, 'sk-old-format-abc'],
    [GEMINI, 'AIzaSyDxxxxxxxxxxxxx'],
  ])('%s accepts %s', (provider, value) => {
    const result = validateKeyPaste({ provider, value })
    expect(result.ok).toBe(true)
    expect(result.warning).toBe(null)
  })
})

describe('validateKeyPaste — opt-outs', () => {
  it('returns ok=true for providers with null key_prefix (ollama)', () => {
    const result = validateKeyPaste({
      provider: OLLAMA,
      value: 'literally-anything',
    })
    expect(result.ok).toBe(true)
    expect(result.warning).toBe(null)
  })

  it('returns ok=true for custom (openai-compatible) — opt-out', () => {
    const result = validateKeyPaste({ provider: CUSTOM, value: 'sk-ant-fake' })
    expect(result.ok).toBe(true)
  })

  it('returns ok=true on empty value (skip path — caller handles save=false)', () => {
    const result = validateKeyPaste({ provider: ANTHROPIC, value: '' })
    expect(result.ok).toBe(true)
    expect(result.warning).toBe(null)
  })
})

describe('validateKeyPaste — cross-provider detection (the main bug fix)', () => {
  it('detects OpenAI sk-proj- key pasted into Anthropic slot', () => {
    const result = validateKeyPaste({
      provider: ANTHROPIC,
      value: 'sk-proj-AAAA-real-openai-key',
    })
    expect(result.ok).toBe(false)
    expect(result.warning).toMatch(/looks like a OpenAI key/)
    expect(result.warning).toMatch(/saving it as Anthropic/)
    // The actionable fix is surfaced inline:
    expect(result.warning).toMatch(/foreman secrets rotate/)
  })

  it('detects Anthropic sk-ant- key pasted into OpenAI slot', () => {
    const result = validateKeyPaste({
      provider: OPENAI,
      value: 'sk-ant-real-anthropic-key',
    })
    expect(result.ok).toBe(false)
    expect(result.warning).toMatch(/looks like a Anthropic key/)
    expect(result.warning).toMatch(/saving it as OpenAI/)
  })

  it('detects Gemini AIza key pasted into Anthropic slot', () => {
    const result = validateKeyPaste({
      provider: ANTHROPIC,
      value: 'AIzaSyDfoobar',
    })
    expect(result.ok).toBe(false)
    expect(result.warning).toMatch(/looks like a Google Gemini key/)
  })

  it('detects Gemini AIza key pasted into OpenAI slot', () => {
    const result = validateKeyPaste({
      provider: OPENAI,
      value: 'AIzaSyDfoobar',
    })
    expect(result.ok).toBe(false)
    expect(result.warning).toMatch(/looks like a Google Gemini key/)
  })
})

describe('validateKeyPaste — unknown prefix (no specific provider match)', () => {
  it('warns when value matches no known prefix at all', () => {
    const result = validateKeyPaste({
      provider: ANTHROPIC,
      value: 'completely-random-string-12345',
    })
    expect(result.ok).toBe(false)
    expect(result.warning).toMatch(
      /expected Anthropic key to start with "sk-ant-"/,
    )
  })

  it('warning is non-cross-provider (mentions only expected prefix)', () => {
    const result = validateKeyPaste({
      provider: GEMINI,
      value: 'totally-bogus-format',
    })
    expect(result.ok).toBe(false)
    expect(result.warning).not.toMatch(/looks like/)
    expect(result.warning).toMatch(/AIza/)
  })
})
