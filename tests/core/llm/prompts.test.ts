import { describe, expect, it } from 'vitest'
import {
  buildVerificationPrompt,
  contextFromAssessment,
  formatRelTime,
  makeCacheKey,
  type PromptContext,
} from '../../../src/core/llm/prompts.js'
import type { RiskAssessment, RiskFactor } from '../../../src/core/risk-rules/types.js'

function factor(
  overrides: Partial<RiskFactor> = {},
): RiskFactor {
  return {
    rule: 'secret_path',
    category: 'secret',
    points: 60,
    reason: '.env-style file',
    ...overrides,
  }
}

function makeCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    sourceAgent: 'hermes',
    sourceResponsibility: 'daily email assistant',
    targetAgent: 'claude-code',
    targetTool: 'read_file',
    args: { path: '.env' },
    factors: [factor()],
    totalScore: 60,
    bucket: 'high',
    recentCalls: [],
    externalTrigger: null,
    ...overrides,
  }
}

describe('buildVerificationPrompt', () => {
  it('renders source + target + tool + args correctly', () => {
    const prompt = buildVerificationPrompt(makeCtx())
    expect(prompt).toContain('Source: hermes')
    expect(prompt).toContain('responsibility: daily email assistant')
    expect(prompt).toContain('Target: claude-code . read_file')
    expect(prompt).toContain('"path": ".env"')
  })

  it('omits responsibility annotation when not set', () => {
    const prompt = buildVerificationPrompt(
      makeCtx({ sourceResponsibility: null }),
    )
    expect(prompt).not.toContain('responsibility:')
  })

  it('lists each factor with its sign + points + reason', () => {
    const prompt = buildVerificationPrompt(
      makeCtx({
        factors: [
          factor({ rule: 'secret_path', points: 60, reason: '.env style' }),
          factor({ rule: 'safe_list', points: -10, reason: 'docs file' }),
        ],
      }),
    )
    expect(prompt).toContain('[+60] secret_path: .env style')
    expect(prompt).toContain('[-10] safe_list: docs file')
  })

  it('renders "(none …)" when factors list is empty', () => {
    const prompt = buildVerificationPrompt(makeCtx({ factors: [] }))
    expect(prompt).toContain('(none — heuristic triggered by policy ask)')
  })

  it('includes total + bucket on the heuristic line', () => {
    const prompt = buildVerificationPrompt(
      makeCtx({ totalScore: 95, bucket: 'critical' }),
    )
    expect(prompt).toContain('Heuristic total: 95 (bucket: critical)')
  })

  it('renders "no recent activity" when recentCalls is empty', () => {
    const prompt = buildVerificationPrompt(makeCtx())
    expect(prompt).toContain('(no recent activity)')
  })

  it('renders up to 3 recent calls with relative time', () => {
    const now = Date.now()
    const prompt = buildVerificationPrompt(
      makeCtx({
        recentCalls: [
          { source: 'hermes', target: 'fs', tool: 'list', decision: 'allowed', ts: now - 30_000 },
          { source: 'hermes', target: 'claude-code', tool: 'read', decision: 'allowed', ts: now - 60_000 },
        ],
      }),
    )
    expect(prompt).toContain('hermes → fs.list: allowed')
    expect(prompt).toContain('hermes → claude-code.read: allowed')
  })

  it('includes external trigger block when set', () => {
    const prompt = buildVerificationPrompt(
      makeCtx({
        externalTrigger: 'Received email from vendor-onboarding@…',
      }),
    )
    expect(prompt).toContain('EXTERNAL TRIGGER')
    expect(prompt).toContain('vendor-onboarding@')
  })

  it('asks for strict JSON output (the response contract)', () => {
    const prompt = buildVerificationPrompt(makeCtx())
    expect(prompt).toContain('OUTPUT — exactly this JSON')
    expect(prompt).toContain('"is_real_threat"')
    expect(prompt).toContain('"recommended_action"')
    expect(prompt).toContain('"additional_risk_score"')
  })
})

describe('makeCacheKey', () => {
  it('returns a stable sha256 hex string', () => {
    const key = makeCacheKey(makeCtx())
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  it('same inputs → same key', () => {
    const k1 = makeCacheKey(makeCtx())
    const k2 = makeCacheKey(makeCtx())
    expect(k1).toBe(k2)
  })

  it('different args reorderings produce the same key (canonicalised)', () => {
    const a = makeCacheKey(makeCtx({ args: { a: 1, b: 2 } }))
    const b = makeCacheKey(makeCtx({ args: { b: 2, a: 1 } }))
    expect(a).toBe(b)
  })

  it('different sourceAgent → different key', () => {
    const a = makeCacheKey(makeCtx({ sourceAgent: 'hermes' }))
    const b = makeCacheKey(makeCtx({ sourceAgent: 'openclaw' }))
    expect(a).not.toBe(b)
  })

  it('different factor sets → different key', () => {
    const a = makeCacheKey(makeCtx({ factors: [factor({ rule: 'secret_path' })] }))
    const b = makeCacheKey(makeCtx({ factors: [factor({ rule: 'shell_sudo' })] }))
    expect(a).not.toBe(b)
  })

  it('factor order does not change the key (sorted internally)', () => {
    const f1 = factor({ rule: 'a' })
    const f2 = factor({ rule: 'b' })
    expect(makeCacheKey(makeCtx({ factors: [f1, f2] }))).toBe(
      makeCacheKey(makeCtx({ factors: [f2, f1] })),
    )
  })

  it('ignores undefined fields inside args', () => {
    const a = makeCacheKey(makeCtx({ args: { a: 1, b: undefined } }))
    const b = makeCacheKey(makeCtx({ args: { a: 1 } }))
    expect(a).toBe(b)
  })
})

describe('formatRelTime', () => {
  it.each([
    [500, 'just now'],
    [30_000, '30s ago'],
    [120_000, '2m ago'],
    [3_600_000, '1h ago'],
    [25 * 3_600_000, '1d ago'],
  ])('formats %d ms → %s', (ms, expected) => {
    expect(formatRelTime(ms)).toBe(expected)
  })
})

describe('contextFromAssessment', () => {
  it('flattens an assessment into PromptContext', () => {
    const assessment: RiskAssessment = {
      factors: [factor()],
      totalScore: 60,
      bucket: 'high',
      recommendation: 'ask',
      llmVerification: null,
    }
    const ctx = contextFromAssessment({
      assessment,
      sourceAgent: 'hermes',
      targetAgent: 'claude-code',
      targetTool: 'read_file',
      callArgs: { path: '.env' },
    })
    expect(ctx.sourceAgent).toBe('hermes')
    expect(ctx.factors).toEqual([factor()])
    expect(ctx.totalScore).toBe(60)
    expect(ctx.bucket).toBe('high')
  })
})
