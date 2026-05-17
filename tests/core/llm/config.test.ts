import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultLlmConfig,
  isFeatureEnabled,
  loadLlmConfig,
  LlmConfigSchema,
  saveLlmConfig,
} from '../../../src/core/llm/config.js'

describe('llm-config — schema + defaults', () => {
  it('default ships globally OFF, all features OFF', () => {
    const c = defaultLlmConfig()
    expect(c.enabled).toBe(false)
    expect(c.features.verification).toBe(false)
    expect(c.features.smart_report).toBe(false)
    expect(c.features.policy_suggestions).toBe(false)
  })

  it('default provider = anthropic + Haiku model', () => {
    const c = defaultLlmConfig()
    expect(c.provider).toBe('anthropic')
    expect(c.model).toMatch(/^claude-haiku-4-5/)
  })

  it('default budget cap = $5, alert at 80%, resets on the 1st', () => {
    const c = defaultLlmConfig()
    expect(c.budget.monthly_cap_usd).toBe(5)
    expect(c.budget.alert_threshold_pct).toBe(80)
    expect(c.budget.reset_day_of_month).toBe(1)
  })

  it('default ships secret refs for every provider', () => {
    const c = defaultLlmConfig()
    expect(c.credentials.anthropic?.secret_name).toBe('anthropic-key')
    expect(c.credentials.openai?.secret_name).toBe('openai-key')
    expect(c.credentials.ollama?.endpoint).toBe('http://localhost:11434')
  })

  it('rejects unknown top-level keys (.strict())', () => {
    expect(() => LlmConfigSchema.parse({ rogue: 'no' })).toThrow()
  })

  it('rejects unknown features (.strict())', () => {
    expect(() =>
      LlmConfigSchema.parse({ features: { rogue_feature: true } }),
    ).toThrow()
  })

  it('rejects invalid budget (negative cap)', () => {
    expect(() =>
      LlmConfigSchema.parse({ budget: { monthly_cap_usd: -1 } }),
    ).toThrow()
  })

  it('rejects reset_day_of_month > 28 (avoid Feb edge cases)', () => {
    expect(() =>
      LlmConfigSchema.parse({ budget: { reset_day_of_month: 31 } }),
    ).toThrow()
  })

  it('rejects unknown provider', () => {
    expect(() => LlmConfigSchema.parse({ provider: 'mistral' })).toThrow()
  })
})

describe('llm-config — load + save', () => {
  let tmpDir: string
  let path: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'llm-cfg-'))
    path = join(tmpDir, 'llm.yaml')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('load returns defaults when file is absent', () => {
    expect(loadLlmConfig(path)).toEqual(defaultLlmConfig())
  })

  it('load handles empty file', () => {
    writeFileSync(path, '', 'utf-8')
    expect(loadLlmConfig(path)).toEqual(defaultLlmConfig())
  })

  it('round-trips load → save → load', () => {
    const config = defaultLlmConfig()
    config.enabled = true
    config.features.verification = true
    config.budget.monthly_cap_usd = 10
    saveLlmConfig(path, config)
    const text = readFileSync(path, 'utf-8')
    expect(text).toContain('enabled: true')
    expect(text).toContain('verification: true')
    const reloaded = loadLlmConfig(path)
    expect(reloaded.enabled).toBe(true)
    expect(reloaded.features.verification).toBe(true)
    expect(reloaded.budget.monthly_cap_usd).toBe(10)
  })

  it('merges partial user config with defaults', () => {
    writeFileSync(path, 'enabled: true\nprovider: openai\n', 'utf-8')
    const c = loadLlmConfig(path)
    expect(c.enabled).toBe(true)
    expect(c.provider).toBe('openai')
    // Defaults filled in for missing keys
    expect(c.model).toMatch(/claude-haiku/)
    expect(c.budget.monthly_cap_usd).toBe(5)
  })

  it('throws on malformed YAML', () => {
    writeFileSync(path, '[oops: bad', 'utf-8')
    expect(() => loadLlmConfig(path)).toThrow()
  })

  it('never writes literal API keys to disk (only refs)', () => {
    const config = defaultLlmConfig()
    saveLlmConfig(path, config)
    const text = readFileSync(path, 'utf-8')
    expect(text).not.toContain('sk-')
    expect(text).not.toContain('Bearer')
    expect(text).toContain('secret_name')
  })
})

describe('isFeatureEnabled', () => {
  it('false when global is off, even if feature is on', () => {
    const c = defaultLlmConfig()
    c.features.verification = true
    expect(isFeatureEnabled(c, 'verification')).toBe(false)
  })

  it('false when global is on but feature is off', () => {
    const c = defaultLlmConfig()
    c.enabled = true
    expect(isFeatureEnabled(c, 'verification')).toBe(false)
  })

  it('true only when BOTH global and feature are on', () => {
    const c = defaultLlmConfig()
    c.enabled = true
    c.features.verification = true
    expect(isFeatureEnabled(c, 'verification')).toBe(true)
  })
})
