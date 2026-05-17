import { describe, expect, it } from 'vitest'
import { templateNarrative } from '../../src/core/narrative-templates.js'
import type {
  RiskAssessment,
  RiskFactor,
} from '../../src/core/risk-rules/types.js'

function factor(over: Partial<RiskFactor> = {}): RiskFactor {
  return {
    rule: 'secret_path',
    category: 'secret',
    points: 60,
    reason: '.env-style file detected',
    ...over,
  }
}

function assessment(over: Partial<RiskAssessment> = {}): RiskAssessment {
  return {
    factors: [factor()],
    totalScore: 70,
    bucket: 'high',
    recommendation: 'ask',
    llmVerification: null,
    ...over,
  }
}

describe('templateNarrative', () => {
  it('lists each fired category with the right footer', () => {
    const n = templateNarrative(
      assessment({
        factors: [
          factor({ category: 'secret', rule: 'secret_path', points: 60 }),
          factor({ category: 'shell', rule: 'shell_dest', points: 50, reason: 'destructive cmd' }),
        ],
        totalScore: 90,
        bucket: 'critical',
      }),
      'llm_disabled',
    )
    expect(n.whatHappening).toContain('credential / secret file')
    expect(n.whatHappening).toContain('shell command')
    expect(n.whatHappening).toContain('Smart analysis is off')
  })

  it('handles empty factor list — policy-asked path', () => {
    const n = templateNarrative(
      assessment({ factors: [], totalScore: 0, bucket: 'medium' }),
      'heuristic_only',
    )
    expect(n.whatHappening).toContain('No specific risk factors fired')
    expect(n.thingsToCheck[0]).toContain('No specific signals')
  })

  it('puts strongest factor first in things-to-check', () => {
    const n = templateNarrative(
      assessment({
        factors: [
          factor({ points: 20, reason: 'minor flag' }),
          factor({ points: 60, reason: '.env path detected' }),
          factor({ points: 30, reason: 'mid flag' }),
        ],
      }),
      'below_threshold',
    )
    expect(n.thingsToCheck[0]).toContain('.env path detected')
  })

  it('adds did-you-initiate prompt for high/critical', () => {
    const n = templateNarrative(
      assessment({ bucket: 'critical' }),
      'heuristic_only',
    )
    expect(n.thingsToCheck.some((s) => s.includes('initiate'))).toBe(true)
  })

  it('omits did-you-initiate prompt for medium', () => {
    const n = templateNarrative(
      assessment({ bucket: 'medium' }),
      'heuristic_only',
    )
    expect(n.thingsToCheck.some((s) => s.includes('initiate'))).toBe(false)
  })

  it('adds shell-specific advisory when shell factors fire', () => {
    const n = templateNarrative(
      assessment({
        factors: [factor({ category: 'shell', rule: 'sh', points: 60, reason: 'rm -rf' })],
      }),
      'heuristic_only',
    )
    expect(
      n.thingsToCheck.some((s) => s.toLowerCase().includes('command line')),
    ).toBe(true)
  })

  it('recommendation mirrors bucket: low → allow, medium+ → ask', () => {
    expect(
      templateNarrative(assessment({ bucket: 'low' }), 'heuristic_only')
        .recommendation,
    ).toBe('allow')
    expect(
      templateNarrative(assessment({ bucket: 'medium' }), 'heuristic_only')
        .recommendation,
    ).toBe('ask')
    expect(
      templateNarrative(assessment({ bucket: 'critical' }), 'heuristic_only')
        .recommendation,
    ).toBe('ask')
  })

  it('caps checklist at 5 items', () => {
    const n = templateNarrative(
      assessment({
        factors: [
          factor({ category: 'secret', points: 60 }),
          factor({ category: 'shell', points: 50, rule: 's2', reason: 'r2' }),
          factor({ category: 'network', points: 40, rule: 's3', reason: 'r3' }),
          factor({ category: 'injection', points: 30, rule: 's4', reason: 'r4' }),
          factor({ category: 'loop', points: 20, rule: 's5', reason: 'r5' }),
        ],
        bucket: 'critical',
      }),
      'heuristic_only',
    )
    expect(n.thingsToCheck.length).toBeLessThanOrEqual(5)
  })

  it('ignores safe-list (negative-points) factors when grouping categories', () => {
    const n = templateNarrative(
      assessment({
        factors: [
          factor({ category: 'secret', points: -20, reason: 'safe-listed' }),
          factor({ category: 'shell', points: 60, reason: 'rm cmd' }),
        ],
      }),
      'heuristic_only',
    )
    expect(n.whatHappening).not.toContain('credential / secret file')
    expect(n.whatHappening).toContain('shell command')
  })
})
