import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultVoiceConfig,
  isProactiveEnabled,
  loadVoiceConfig,
  saveVoiceConfig,
  VoiceConfigSchema,
} from '../../../src/core/notification/voice-config.js'

// =============================================================================
// Tests for #305 — voice.yaml schema + load/save
// =============================================================================
//
// Pins the schema contract:
//   - defaults pre-populate every nested field (no partial parse errors)
//   - load → save → load round-trips
//   - missing file falls back to defaults
//   - malformed YAML / wrong types throw
//   - isProactiveEnabled accessor agrees with the per-type flag

describe('VoiceConfigSchema — defaults', () => {
  it('produces a fully-populated VoiceConfig from an empty input', () => {
    const cfg = VoiceConfigSchema.parse({})
    expect(cfg.proactive_notifications.daily_summary.enabled).toBe(true)
    expect(cfg.proactive_notifications.weekly_summary.enabled).toBe(false)
    expect(cfg.proactive_notifications.pattern_detection.enabled).toBe(true)
    expect(
      cfg.proactive_notifications.pattern_detection.min_pattern_frequency,
    ).toBe(3)
    expect(cfg.proactive_notifications.pattern_detection.cooldown_minutes).toBe(
      60,
    )
    expect(cfg.proactive_notifications.agent_health_alerts.enabled).toBe(true)
    expect(cfg.proactive_notifications.budget_alerts.threshold_percent).toBe(80)
    expect(cfg.quiet_hours.enabled).toBe(true)
    expect(cfg.quiet_hours.from).toBe('23:00')
    expect(cfg.quiet_hours.to).toBe('08:00')
    expect(cfg.quiet_hours.exception).toBe('critical')
  })

  it('defaultVoiceConfig() returns the same shape', () => {
    const direct = VoiceConfigSchema.parse({})
    const helper = defaultVoiceConfig()
    expect(helper).toEqual(direct)
  })
})

describe('VoiceConfigSchema — validation errors', () => {
  it('rejects an unknown top-level key (strict schema)', () => {
    expect(() =>
      VoiceConfigSchema.parse({ unknown_field: true }),
    ).toThrow()
  })

  it('rejects an unknown channel id', () => {
    expect(() =>
      VoiceConfigSchema.parse({
        proactive_notifications: {
          daily_summary: { channel: 'pigeon' },
        },
      }),
    ).toThrow()
  })

  it('rejects threshold_percent outside 0-100', () => {
    expect(() =>
      VoiceConfigSchema.parse({
        proactive_notifications: { budget_alerts: { threshold_percent: 150 } },
      }),
    ).toThrow()
  })

  it('rejects an unknown quiet_hours.exception value', () => {
    expect(() =>
      VoiceConfigSchema.parse({
        quiet_hours: { exception: 'eclipse' },
      }),
    ).toThrow()
  })
})

describe('loadVoiceConfig / saveVoiceConfig — file I/O', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'foreman-voice-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('returns defaults when the file does not exist', () => {
    const cfg = loadVoiceConfig(join(tmp, 'nope.yaml'))
    expect(cfg.quiet_hours.enabled).toBe(true)
  })

  it('round-trips through save → load with edits preserved', () => {
    const path = join(tmp, 'voice.yaml')
    const cfg = defaultVoiceConfig()
    cfg.proactive_notifications.daily_summary.schedule = '21:30'
    cfg.proactive_notifications.pattern_detection.cooldown_minutes = 15
    cfg.quiet_hours.from = '22:30'
    saveVoiceConfig(path, cfg)
    const back = loadVoiceConfig(path)
    expect(back.proactive_notifications.daily_summary.schedule).toBe('21:30')
    expect(back.proactive_notifications.pattern_detection.cooldown_minutes).toBe(
      15,
    )
    expect(back.quiet_hours.from).toBe('22:30')
  })

  it('merges partial files with defaults (only daily_summary present)', () => {
    const path = join(tmp, 'voice.yaml')
    writeFileSync(
      path,
      `proactive_notifications:\n  daily_summary:\n    enabled: false\n`,
      'utf-8',
    )
    const cfg = loadVoiceConfig(path)
    expect(cfg.proactive_notifications.daily_summary.enabled).toBe(false)
    // Other sections + quiet_hours come from defaults
    expect(cfg.proactive_notifications.pattern_detection.enabled).toBe(true)
    expect(cfg.quiet_hours.enabled).toBe(true)
  })

  it('throws on syntactically broken YAML (caller surfaces via doctor)', () => {
    const path = join(tmp, 'voice.yaml')
    writeFileSync(path, 'proactive_notifications: {[invalid yaml', 'utf-8')
    expect(() => loadVoiceConfig(path)).toThrow()
  })

  it('treats an empty file as defaults', () => {
    const path = join(tmp, 'voice.yaml')
    writeFileSync(path, '', 'utf-8')
    const cfg = loadVoiceConfig(path)
    expect(cfg.quiet_hours.enabled).toBe(true)
  })

  it('writes valid yaml (re-parseable)', () => {
    const path = join(tmp, 'voice.yaml')
    saveVoiceConfig(path, defaultVoiceConfig())
    const text = readFileSync(path, 'utf-8')
    expect(text).toContain('proactive_notifications:')
    expect(text).toContain('quiet_hours:')
    expect(() => loadVoiceConfig(path)).not.toThrow()
  })
})

describe('isProactiveEnabled', () => {
  it.each([
    ['daily_summary', true],
    ['weekly_summary', false],
    ['pattern_detection', true],
    ['agent_health', true],
    ['budget_alert', true],
  ] as const)('%s defaults to %s', (type, expected) => {
    expect(isProactiveEnabled(defaultVoiceConfig(), type)).toBe(expected)
  })

  it('reflects user overrides', () => {
    const cfg = defaultVoiceConfig()
    cfg.proactive_notifications.pattern_detection.enabled = false
    expect(isProactiveEnabled(cfg, 'pattern_detection')).toBe(false)
  })
})
