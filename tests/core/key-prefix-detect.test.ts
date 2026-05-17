import { describe, expect, it } from 'vitest'
import {
  detectProviderByPrefix,
  KNOWN_PREFIXES,
} from '../../src/core/key-prefix-detect.js'

// =============================================================================
// Tests for the shared most-specific-prefix-wins detector used by both
// the wizard paste validator (#291) and the doctor llm.credentials check
// (#307).
// =============================================================================

describe('detectProviderByPrefix', () => {
  it('matches Anthropic on sk-ant- (more specific than OpenAI sk-)', () => {
    const r = detectProviderByPrefix('sk-ant-api03-abc')
    expect(r?.providerId).toBe('anthropic')
    expect(r?.provider).toBe('Anthropic')
    expect(r?.prefix).toBe('sk-ant-')
  })

  it('matches OpenAI on sk-proj- (more specific than sk-)', () => {
    const r = detectProviderByPrefix('sk-proj-real-openai')
    expect(r?.providerId).toBe('openai')
    expect(r?.prefix).toBe('sk-proj-')
  })

  it('matches OpenAI on bare sk- when no more-specific prefix matches', () => {
    const r = detectProviderByPrefix('sk-old-format-key')
    expect(r?.providerId).toBe('openai')
    expect(r?.prefix).toBe('sk-')
  })

  it('matches Gemini on AIza', () => {
    const r = detectProviderByPrefix('AIzaSyDfoobar')
    expect(r?.providerId).toBe('gemini')
    expect(r?.prefix).toBe('AIza')
  })

  it('returns null for values matching no known prefix', () => {
    expect(detectProviderByPrefix('random-string')).toBeNull()
    expect(detectProviderByPrefix('')).toBeNull()
    expect(detectProviderByPrefix('placeholder-paste-key-here')).toBeNull()
  })

  it('KNOWN_PREFIXES covers anthropic + openai (×2) + gemini', () => {
    const ids = KNOWN_PREFIXES.map((p) => p.providerId)
    expect(ids).toContain('anthropic')
    expect(ids).toContain('openai')
    expect(ids).toContain('gemini')
  })
})
