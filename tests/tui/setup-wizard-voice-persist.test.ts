import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultVoiceConfig,
  loadVoiceConfig,
  saveVoiceConfig,
} from '../../src/core/notification/voice-config.js'
import {
  buildVoiceConfigFromWizard,
  persistVoiceConfig,
} from '../../src/tui/setup-wizard-voice-persist.js'

// =============================================================================
// Tests for #305 — wizard → voice.yaml seed (services step)
// =============================================================================

describe('buildVoiceConfigFromWizard (pure)', () => {
  it('keeps proactive types enabled when at least one channel is wired', () => {
    const result = buildVoiceConfigFromWizard({
      existing: defaultVoiceConfig(),
      wiredChannels: ['telegram'],
    })
    expect(result.disabledForNoChannel).toBe(false)
    expect(
      result.next.proactive_notifications.daily_summary.enabled,
    ).toBe(true)
  })

  it('disables all proactive types when no channel is wired (no spam)', () => {
    const result = buildVoiceConfigFromWizard({
      existing: defaultVoiceConfig(),
      wiredChannels: [],
    })
    expect(result.disabledForNoChannel).toBe(true)
    expect(
      result.next.proactive_notifications.daily_summary.enabled,
    ).toBe(false)
    expect(
      result.next.proactive_notifications.pattern_detection.enabled,
    ).toBe(false)
    expect(
      result.next.proactive_notifications.budget_alerts.enabled,
    ).toBe(false)
  })

  it('preserves user-overridden fields when channels are wired', () => {
    const existing = defaultVoiceConfig()
    existing.proactive_notifications.pattern_detection.cooldown_minutes = 15
    existing.quiet_hours.from = '21:00'
    const result = buildVoiceConfigFromWizard({
      existing,
      wiredChannels: ['telegram'],
    })
    expect(
      result.next.proactive_notifications.pattern_detection.cooldown_minutes,
    ).toBe(15)
    expect(result.next.quiet_hours.from).toBe('21:00')
  })
})

describe('persistVoiceConfig (side-effecting)', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'foreman-voice-persist-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('creates voice.yaml when absent (defaults seeded)', () => {
    const path = join(tmp, 'voice.yaml')
    const result = persistVoiceConfig(path, ['telegram'])
    expect(result.wrote).toBe(true)
    const cfg = loadVoiceConfig(path)
    expect(cfg.quiet_hours.enabled).toBe(true)
  })

  it('preserves an existing file with hand edits', () => {
    const path = join(tmp, 'voice.yaml')
    const initial = defaultVoiceConfig()
    initial.proactive_notifications.daily_summary.schedule = '21:30'
    saveVoiceConfig(path, initial)

    persistVoiceConfig(path, ['telegram'])
    const after = loadVoiceConfig(path)
    expect(after.proactive_notifications.daily_summary.schedule).toBe('21:30')
  })

  it('overwrites a malformed file with defaults', () => {
    const path = join(tmp, 'voice.yaml')
    // Write garbage that voice-config will fail to parse
    require('node:fs').writeFileSync(path, '{[ not yaml', 'utf-8')
    const result = persistVoiceConfig(path, ['telegram'])
    expect(result.wrote).toBe(true)
    const cfg = loadVoiceConfig(path)
    expect(cfg.quiet_hours.enabled).toBe(true)
  })

  it('writes disabled state when no channel was wired', () => {
    const path = join(tmp, 'voice.yaml')
    const result = persistVoiceConfig(path, [])
    expect(result.disabledForNoChannel).toBe(true)
    const cfg = loadVoiceConfig(path)
    expect(cfg.proactive_notifications.daily_summary.enabled).toBe(false)
    expect(cfg.proactive_notifications.pattern_detection.enabled).toBe(false)
  })

  it('produces parseable YAML on disk', () => {
    const path = join(tmp, 'voice.yaml')
    persistVoiceConfig(path, ['telegram'])
    const text = readFileSync(path, 'utf-8')
    expect(text).toContain('proactive_notifications:')
    expect(text).toContain('quiet_hours:')
  })
})
