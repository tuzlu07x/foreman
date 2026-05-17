import { describe, expect, it } from 'vitest'
import {
  findDuplicateSlots,
  legacySlotsToRemove,
} from '../../src/core/secret-slot-migration.js'

// =============================================================================
// Tests for #342 — legacy <provider>-api-key migration helper
// =============================================================================

describe('findDuplicateSlots', () => {
  it('returns empty when no canonical slot exists', () => {
    expect(findDuplicateSlots(['anthropic-api-key'])).toEqual([])
  })

  it('returns empty when no legacy slot exists', () => {
    expect(findDuplicateSlots(['anthropic-key', 'openai-key'])).toEqual([])
  })

  it('returns the pair when both canonical + legacy exist', () => {
    const dupes = findDuplicateSlots([
      'anthropic-key',
      'anthropic-api-key',
      'openai-key',
    ])
    expect(dupes).toHaveLength(1)
    expect(dupes[0]).toMatchObject({
      canonical: 'anthropic-key',
      legacy: 'anthropic-api-key',
      provider: 'anthropic',
    })
  })

  it('handles every supported provider', () => {
    const dupes = findDuplicateSlots([
      'anthropic-key',
      'anthropic-api-key',
      'openai-key',
      'openai-api-key',
      'gemini-key',
      'gemini-api-key',
      'openai-compatible-key',
      'openai-compatible-api-key',
    ])
    expect(dupes.map((d) => d.provider).sort()).toEqual([
      'anthropic',
      'gemini',
      'openai',
      'openai_compatible',
    ])
  })

  it('ignores unrelated secrets (telegram, github, custom names)', () => {
    expect(
      findDuplicateSlots([
        'telegram-bot-token',
        'github-pat',
        'my-custom-secret',
      ]),
    ).toEqual([])
  })
})

describe('legacySlotsToRemove', () => {
  it('returns all legacy slots when no last-accessed map supplied', () => {
    const dupes = findDuplicateSlots(['anthropic-key', 'anthropic-api-key'])
    expect(legacySlotsToRemove(dupes)).toEqual(['anthropic-api-key'])
  })

  it('keeps legacy slot when it was accessed more recently than canonical', () => {
    const dupes = findDuplicateSlots(['anthropic-key', 'anthropic-api-key'])
    const access = (name: string) =>
      name === 'anthropic-api-key' ? 2000 : 1000
    expect(legacySlotsToRemove(dupes, access)).toEqual([])
  })

  it('removes legacy slot when canonical is more recent', () => {
    const dupes = findDuplicateSlots(['anthropic-key', 'anthropic-api-key'])
    const access = (name: string) =>
      name === 'anthropic-key' ? 2000 : 1000
    expect(legacySlotsToRemove(dupes, access)).toEqual(['anthropic-api-key'])
  })

  it('removes legacy when access times tie (canonical wins on tie)', () => {
    const dupes = findDuplicateSlots(['openai-key', 'openai-api-key'])
    const access = () => 1000
    expect(legacySlotsToRemove(dupes, access)).toEqual(['openai-api-key'])
  })

  it('null access time treated as 0 — canonical wins by default', () => {
    const dupes = findDuplicateSlots(['gemini-key', 'gemini-api-key'])
    const access = () => null
    expect(legacySlotsToRemove(dupes, access)).toEqual(['gemini-api-key'])
  })

  it('returns one entry per pair (no double-counting on multi-provider input)', () => {
    const dupes = findDuplicateSlots([
      'anthropic-key',
      'anthropic-api-key',
      'openai-key',
      'openai-api-key',
    ])
    expect(legacySlotsToRemove(dupes)).toEqual([
      'anthropic-api-key',
      'openai-api-key',
    ])
  })
})
