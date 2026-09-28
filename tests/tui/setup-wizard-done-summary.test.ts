import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { installPreToolUseHook } from '../../src/core/agent-hook.js'
import { loadLlmPresets } from '../../src/core/llm-provider-presets.js'
import { claudeHookInstalled, configuredPresetIds, doneServiceIds } from '../../src/tui/setup-wizard/done.js'

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

// Terminal QA: the Done screen said how to launch Claude Code but never
// that its PreToolUse hook (checks Bash / Edit / Read before they run) is
// a separate opt-in. It now suggests `foreman agent hook install
// claude-code` while the hook isn't there.
describe('claudeHookInstalled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fm-done-hook-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('is false without a settings file or without the hook', () => {
    expect(claudeHookInstalled([join(dir, 'missing.json')])).toBe(false)
    const plain = join(dir, 'plain.json')
    writeFileSync(plain, JSON.stringify({ theme: 'dark' }))
    expect(claudeHookInstalled([plain])).toBe(false)
  })

  it('is true once the hook is installed', () => {
    const path = join(dir, 'hooked.json')
    writeFileSync(path, '{}')
    installPreToolUseHook({ settingsPath: path, hookCommand: 'foreman-hook claude-code' })
    expect(claudeHookInstalled([path])).toBe(true)
  })

  it('is null when the settings file cannot be read', () => {
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{ not json')
    expect(claudeHookInstalled([bad])).toBeNull()
  })
})
