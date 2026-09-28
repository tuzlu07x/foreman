import { describe, expect, it } from 'vitest'
import { loadLlmPresets } from '../../src/core/llm-provider-presets.js'
import { configuredPresetIds, doneServiceIds } from '../../src/tui/setup-wizard/done.js'

// =============================================================================
// Done summary counts an OpenAI-compatible preset chosen as Foreman's brain.
// Its key lives in the preset's own slot (e.g. deepseek-api-key), which the
// provider catalog didn't know, so the summary said "1 LLM provider openai"
// after the user had also set up DeepSeek.
// =============================================================================

describe('configuredPresetIds', () => {
  const presets = loadLlmPresets().presets

  it('lists the presets whose key is stored', () => {
    const deepseek = presets.find((p) => p.id === 'deepseek')
    expect(deepseek).toBeDefined()
    expect(configuredPresetIds(presets, new Set([deepseek!.key_secret_name, 'openai-key']))).toEqual([
      'deepseek',
    ])
  })

  it('is empty when no preset key is stored', () => {
    expect(configuredPresetIds(presets, new Set(['openai-key']))).toEqual([])
  })
})

describe('doneServiceIds', () => {
  const catalog = [
    { id: 'telegram', secret_name: 'telegram-bot-token' },
    { id: 'github', secret_name: 'github-pat' },
    { id: 'notion', secret_name: 'notion-token' },
  ]

  it("doesn't count an integration's stored secret as a service", () => {
    expect(doneServiceIds(catalog, new Set(['github-pat', 'notion-token']))).toEqual([])
    expect(doneServiceIds(catalog, new Set(['github-pat', 'telegram-bot-token']))).toEqual(['telegram'])
  })
})
