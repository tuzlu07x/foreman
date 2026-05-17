import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runInit } from '../../src/cli/init.js'
import { checkLlmBudget } from '../../src/core/doctor.js'
import { recordUsage } from '../../src/core/llm/budget.js'
import { closeDb, getDb } from '../../src/db/client.js'

describe('checkLlmBudget', () => {
  let tmp: string
  let previousHome: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'foreman-doctor-budget-'))
    previousHome = process.env.FOREMAN_HOME
    process.env.FOREMAN_HOME = tmp
  })

  afterEach(() => {
    closeDb()
    if (previousHome === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = previousHome
    rmSync(tmp, { recursive: true, force: true })
  })

  it('ok when llm.yaml is absent (default disabled state)', () => {
    runInit()
    const result = checkLlmBudget()
    expect(result.status).toBe('ok')
    expect(result.message).toContain('absent')
  })

  it('ok when llm.yaml exists but global switch is off', () => {
    runInit()
    writeFileSync(
      join(tmp, 'llm.yaml'),
      'enabled: false\nprovider: anthropic\nmodel: m\n',
      'utf-8',
    )
    const result = checkLlmBudget()
    expect(result.status).toBe('ok')
    expect(result.message).toContain('global switch is off')
  })

  it('ok when LLM enabled and spending is well below alert threshold', () => {
    runInit()
    writeFileSync(
      join(tmp, 'llm.yaml'),
      `enabled: true
provider: anthropic
model: m
budget:
  monthly_cap_usd: 5
  alert_threshold_pct: 80
  reset_day_of_month: 1
`,
      'utf-8',
    )
    const db = getDb()
    recordUsage(db, {
      provider: 'a',
      model: 'm',
      feature: 'verification',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0.5,
      durationMs: 1,
    })
    const result = checkLlmBudget()
    expect(result.status).toBe('ok')
    expect(result.message).toContain('well under')
  })

  it('warn when budget alert threshold is tripped', () => {
    runInit()
    writeFileSync(
      join(tmp, 'llm.yaml'),
      `enabled: true
provider: anthropic
model: m
budget:
  monthly_cap_usd: 1
  alert_threshold_pct: 80
  reset_day_of_month: 1
`,
      'utf-8',
    )
    const db = getDb()
    recordUsage(db, {
      provider: 'a',
      model: 'm',
      feature: 'verification',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0.85,
      durationMs: 1,
    })
    const result = checkLlmBudget()
    expect(result.status).toBe('warn')
    expect(result.message).toContain('alert tripped')
    expect(result.remediation).toContain('foreman llm')
  })

  it('fail when budget is exhausted', () => {
    runInit()
    writeFileSync(
      join(tmp, 'llm.yaml'),
      `enabled: true
provider: anthropic
model: m
budget:
  monthly_cap_usd: 1
  alert_threshold_pct: 80
  reset_day_of_month: 1
`,
      'utf-8',
    )
    const db = getDb()
    recordUsage(db, {
      provider: 'a',
      model: 'm',
      feature: 'verification',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 1.2,
      durationMs: 1,
    })
    const result = checkLlmBudget()
    expect(result.status).toBe('fail')
    expect(result.message).toContain('exhausted')
    expect(result.remediation).toContain('--set')
  })
})
