import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runInit } from '../../src/cli/init.js'
import { checkVoiceConfig } from '../../src/core/doctor.js'
import { closeDb } from '../../src/db/client.js'

// =============================================================================
// Tests for #305 — doctor voice_config check
// =============================================================================

describe('checkVoiceConfig', () => {
  let tmp: string
  let previousHome: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'foreman-doctor-voice-'))
    previousHome = process.env.FOREMAN_HOME
    process.env.FOREMAN_HOME = tmp
  })

  afterEach(() => {
    closeDb()
    if (previousHome === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = previousHome
    rmSync(tmp, { recursive: true, force: true })
  })

  it('ok when voice.yaml is absent (defaults active)', () => {
    runInit()
    const r = checkVoiceConfig()
    expect(r.status).toBe('ok')
    expect(r.message).toMatch(/absent.*defaults/)
  })

  it('ok with parses summary listing enabled types when file is present', () => {
    runInit()
    writeFileSync(
      join(tmp, 'voice.yaml'),
      `proactive_notifications:
  daily_summary:
    enabled: true
    schedule: "20:00"
    channel: telegram
  weekly_summary:
    enabled: false
  pattern_detection:
    enabled: true
quiet_hours:
  enabled: true
  from: "23:00"
  to: "08:00"
`,
      'utf-8',
    )
    const r = checkVoiceConfig()
    expect(r.status).toBe('ok')
    expect(r.message).toMatch(/parses/)
    expect(r.message).toMatch(/daily_summary/)
    expect(r.message).toMatch(/pattern_detection/)
    expect(r.message).toMatch(/23:00.*08:00/)
  })

  it('warns when voice.yaml is malformed (surfaces remediation)', () => {
    runInit()
    writeFileSync(join(tmp, 'voice.yaml'), '{[ not yaml', 'utf-8')
    const r = checkVoiceConfig()
    expect(r.status).toBe('warn')
    expect(r.message).toMatch(/unreadable/)
    expect(r.remediation).toContain('Delete voice.yaml')
  })

  it('still ok when all proactive types are disabled (no quietness check)', () => {
    runInit()
    writeFileSync(
      join(tmp, 'voice.yaml'),
      `proactive_notifications:
  daily_summary: { enabled: false }
  weekly_summary: { enabled: false }
  pattern_detection: { enabled: false }
  agent_health_alerts: { enabled: false }
  budget_alerts: { enabled: false }
quiet_hours: { enabled: false, from: "23:00", to: "08:00" }
`,
      'utf-8',
    )
    const r = checkVoiceConfig()
    expect(r.status).toBe('ok')
    expect(r.message).toMatch(/all proactive types disabled/)
    expect(r.message).toMatch(/quiet hours disabled/)
  })
})
