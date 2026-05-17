import { describe, expect, it } from 'vitest'
import type { ForemanDb } from '../../../src/db/client.js'
import type { ResponsibilityPolicy } from '../../../src/core/policy-engine.js'
import type {
  RiskContext,
  RiskRequest,
} from '../../../src/core/risk-rules/types.js'
import { responsibilityViolationRule } from '../../../src/core/risk-rules/responsibility-violation.js'

// =============================================================================
// Tests for #300 — responsibility-violation rule
// =============================================================================
//
// Pins the four scoring paths:
//   1. cannot_access path match → +60
//   2. cannot_call_agents_with_responsibility delegation → +50
//   3. can_use_services allowlist mismatch → +40
//   4. no-op cases (context not wired / source has no responsibility / no
//      matching policy)
//
// Uses a fake context — the rule shouldn't touch the DB at all.

function makeContext(opts: {
  responsibilities?: Record<string, string>
  policies?: ResponsibilityPolicy[]
}): RiskContext {
  return {
    db: {} as ForemanDb, // never read in this rule
    getAgentResponsibility: opts.responsibilities
      ? (agentId) => opts.responsibilities![agentId] ?? null
      : undefined,
    responsibilityPolicies: opts.policies
      ? () => opts.policies!
      : undefined,
  }
}

function req(overrides: Partial<RiskRequest>): RiskRequest {
  return {
    sourceAgent: 'hermes',
    ...overrides,
  }
}

describe('responsibilityViolationRule — no-op cases', () => {
  it('returns no factors when context lookups are not wired', () => {
    const factors = responsibilityViolationRule.evaluate(
      req({ args: { path: '/.ssh/id_rsa' } }),
      { db: {} as ForemanDb },
    )
    expect(factors).toEqual([])
  })

  it('returns no factors when the source agent has no responsibility note', () => {
    const ctx = makeContext({
      responsibilities: {},
      policies: [
        {
          responsibility: 'code writing',
          cannot_access: ['/\\.ssh/'],
        },
      ],
    })
    const factors = responsibilityViolationRule.evaluate(
      req({ args: { path: '/.ssh/id_rsa' } }),
      ctx,
    )
    expect(factors).toEqual([])
  })

  it("returns no factors when the source's responsibility doesn't match any policy", () => {
    const ctx = makeContext({
      responsibilities: { hermes: 'something obscure' },
      policies: [
        {
          responsibility: 'code writing',
          cannot_access: ['/\\.ssh/'],
        },
      ],
    })
    const factors = responsibilityViolationRule.evaluate(
      req({ args: { path: '/.ssh/id_rsa' } }),
      ctx,
    )
    expect(factors).toEqual([])
  })
})

describe('responsibilityViolationRule — cannot_access', () => {
  it('fires +60 when path matches a cannot_access pattern', () => {
    const ctx = makeContext({
      responsibilities: { hermes: 'code writing' },
      policies: [
        {
          responsibility: 'code writing',
          cannot_access: ['/\\.ssh/', '^/etc/passwd$'],
        },
      ],
    })
    const factors = responsibilityViolationRule.evaluate(
      req({ args: { path: '/home/me/.ssh/id_rsa' } }),
      ctx,
    )
    expect(factors).toHaveLength(1)
    expect(factors[0]).toMatchObject({
      rule: 'responsibility_violation',
      category: 'structural',
      points: 60,
    })
    expect(factors[0]!.reason).toContain("hermes's declared role")
    expect(factors[0]!.reason).toContain('code writing')
    expect(factors[0]!.evidence).toBe('/home/me/.ssh/id_rsa')
  })

  it('matches responsibility case-insensitively', () => {
    const ctx = makeContext({
      responsibilities: { hermes: 'Code Writing' },
      policies: [
        {
          responsibility: 'code writing',
          cannot_access: ['^/etc/passwd$'],
        },
      ],
    })
    const factors = responsibilityViolationRule.evaluate(
      req({ args: { path: '/etc/passwd' } }),
      ctx,
    )
    expect(factors).toHaveLength(1)
  })

  it('emits at most one cannot_access factor per policy (no duplicate scoring)', () => {
    const ctx = makeContext({
      responsibilities: { hermes: 'code writing' },
      policies: [
        {
          responsibility: 'code writing',
          cannot_access: ['/\\.ssh/', 'id_rsa$'], // both match
        },
      ],
    })
    const factors = responsibilityViolationRule.evaluate(
      req({ args: { path: '/.ssh/id_rsa' } }),
      ctx,
    )
    expect(factors).toHaveLength(1)
  })

  it('treats invalid regex as substring fallback (no crash)', () => {
    const ctx = makeContext({
      responsibilities: { hermes: 'code writing' },
      policies: [
        {
          responsibility: 'code writing',
          cannot_access: ['/.ssh/((bad-regex'], // unbalanced paren
        },
      ],
    })
    const factors = responsibilityViolationRule.evaluate(
      req({ args: { path: '/.ssh/((bad-regex' } }),
      ctx,
    )
    expect(factors).toHaveLength(1)
  })

  it('does not fire when no path is present in args', () => {
    const ctx = makeContext({
      responsibilities: { hermes: 'code writing' },
      policies: [
        {
          responsibility: 'code writing',
          cannot_access: ['/\\.ssh/'],
        },
      ],
    })
    const factors = responsibilityViolationRule.evaluate(
      req({ args: { cmd: 'ls' } }),
      ctx,
    )
    expect(factors).toEqual([])
  })
})

describe('responsibilityViolationRule — cannot_call_agents_with_responsibility', () => {
  it('fires +50 when target agent has a forbidden responsibility', () => {
    const ctx = makeContext({
      responsibilities: {
        hermes: 'code writing',
        billing: 'payment processing',
      },
      policies: [
        {
          responsibility: 'code writing',
          cannot_call_agents_with_responsibility: ['payment processing'],
        },
      ],
    })
    const factors = responsibilityViolationRule.evaluate(
      req({ sourceAgent: 'hermes', targetAgent: 'billing' }),
      ctx,
    )
    expect(factors).toHaveLength(1)
    expect(factors[0]).toMatchObject({
      rule: 'responsibility_violation_delegation',
      points: 50,
    })
    expect(factors[0]!.reason).toContain('hermes')
    expect(factors[0]!.reason).toContain('billing')
    expect(factors[0]!.reason).toContain('payment processing')
  })

  it('does not fire when target responsibility is not in the forbidden list', () => {
    const ctx = makeContext({
      responsibilities: {
        hermes: 'code writing',
        reviewer: 'code review',
      },
      policies: [
        {
          responsibility: 'code writing',
          cannot_call_agents_with_responsibility: ['payment processing'],
        },
      ],
    })
    const factors = responsibilityViolationRule.evaluate(
      req({ sourceAgent: 'hermes', targetAgent: 'reviewer' }),
      ctx,
    )
    expect(factors).toEqual([])
  })

  it('does not fire when target agent is unknown (no responsibility recorded)', () => {
    const ctx = makeContext({
      responsibilities: { hermes: 'code writing' },
      policies: [
        {
          responsibility: 'code writing',
          cannot_call_agents_with_responsibility: ['payment processing'],
        },
      ],
    })
    const factors = responsibilityViolationRule.evaluate(
      req({ sourceAgent: 'hermes', targetAgent: 'mystery-agent' }),
      ctx,
    )
    expect(factors).toEqual([])
  })
})

describe('responsibilityViolationRule — can_use_services (allowlist)', () => {
  it('fires +40 when target is a service NOT in the role allowlist', () => {
    const ctx = makeContext({
      responsibilities: { hermes: 'code writing' },
      policies: [
        {
          responsibility: 'code writing',
          can_use_services: ['github'], // telegram not allowed
        },
      ],
    })
    const factors = responsibilityViolationRule.evaluate(
      req({ sourceAgent: 'hermes', targetAgent: 'telegram' }),
      ctx,
    )
    expect(factors).toHaveLength(1)
    expect(factors[0]).toMatchObject({
      rule: 'responsibility_violation_service',
      points: 40,
    })
    expect(factors[0]!.reason).toContain('telegram')
    expect(factors[0]!.reason).toContain('github')
  })

  it('does not fire when target is in the allowlist', () => {
    const ctx = makeContext({
      responsibilities: { hermes: 'code writing' },
      policies: [
        {
          responsibility: 'code writing',
          can_use_services: ['github'],
        },
      ],
    })
    const factors = responsibilityViolationRule.evaluate(
      req({ sourceAgent: 'hermes', targetAgent: 'github' }),
      ctx,
    )
    expect(factors).toEqual([])
  })

  it('does not fire when target is not a known service id', () => {
    const ctx = makeContext({
      responsibilities: { hermes: 'code writing' },
      policies: [
        {
          responsibility: 'code writing',
          can_use_services: ['github'],
        },
      ],
    })
    const factors = responsibilityViolationRule.evaluate(
      req({ sourceAgent: 'hermes', targetAgent: 'claude-code' }),
      ctx,
    )
    // claude-code is an agent, not a service → can_use_services check skipped
    expect(factors).toEqual([])
  })

  it('does not fire when policy has no can_use_services (no constraint)', () => {
    const ctx = makeContext({
      responsibilities: { hermes: 'code writing' },
      policies: [
        {
          responsibility: 'code writing',
          cannot_access: ['/\\.ssh/'], // unrelated
        },
      ],
    })
    const factors = responsibilityViolationRule.evaluate(
      req({ sourceAgent: 'hermes', targetAgent: 'telegram' }),
      ctx,
    )
    expect(factors).toEqual([])
  })
})

describe('responsibilityViolationRule — composite', () => {
  it('emits multiple factors when the same call violates multiple rules', () => {
    const ctx = makeContext({
      responsibilities: {
        hermes: 'code writing',
        billing: 'payment processing',
      },
      policies: [
        {
          responsibility: 'code writing',
          cannot_access: ['/\\.ssh/'],
          cannot_call_agents_with_responsibility: ['payment processing'],
        },
      ],
    })
    const factors = responsibilityViolationRule.evaluate(
      req({
        sourceAgent: 'hermes',
        targetAgent: 'billing',
        args: { path: '/.ssh/id_rsa' },
      }),
      ctx,
    )
    expect(factors).toHaveLength(2)
    expect(factors.map((f) => f.rule).sort()).toEqual([
      'responsibility_violation',
      'responsibility_violation_delegation',
    ])
    expect(factors.reduce((sum, f) => sum + f.points, 0)).toBe(110)
  })

  it('respects multiple policies for the same responsibility (additive)', () => {
    const ctx = makeContext({
      responsibilities: { hermes: 'code writing' },
      policies: [
        {
          responsibility: 'code writing',
          cannot_access: ['/\\.ssh/'],
        },
        {
          responsibility: 'code writing',
          cannot_access: ['^/etc/'],
        },
      ],
    })
    const factors = responsibilityViolationRule.evaluate(
      req({ sourceAgent: 'hermes', args: { path: '/etc/passwd' } }),
      ctx,
    )
    // Second policy matches; first doesn't → 1 factor total
    expect(factors).toHaveLength(1)
  })
})
