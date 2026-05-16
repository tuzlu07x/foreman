import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bucketFor,
  composeAssessment,
  DEFAULT_RISK_RULES,
  recommendationFor,
  RISK_THRESHOLD,
  RiskScorer,
} from '../../src/core/risk-scorer.js'
import type {
  RiskFactor,
  RiskRule,
} from '../../src/core/risk-rules/types.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { requests } from '../../src/db/schema.js'

function seedRequest(
  db: ForemanDb,
  overrides: Partial<typeof requests.$inferInsert> = {},
): void {
  db.insert(requests)
    .values({
      id: overrides.id ?? `r-${Math.random().toString(36).slice(2)}`,
      sourceAgent: overrides.sourceAgent ?? 'hermes',
      targetAgent: overrides.targetAgent ?? null,
      targetTool: overrides.targetTool ?? null,
      args: overrides.args ?? '{}',
      riskScore: overrides.riskScore ?? 0,
      decision: overrides.decision ?? 'allowed',
      createdAt: overrides.createdAt ?? Date.now(),
    })
    .run()
}

function ruleNames(factors: RiskFactor[]): string[] {
  return factors.map((f) => f.rule)
}

describe('RiskScorer', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let scorer: RiskScorer

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    scorer = new RiskScorer(db)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('exposes the documented threshold (30 — medium bucket floor)', () => {
    expect(RISK_THRESHOLD).toBe(30)
  })

  it('ships the documented five default rules in order', () => {
    expect(DEFAULT_RISK_RULES.map((r) => r.name)).toEqual([
      'secret_file_pattern',
      'outbound_network',
      'shell_exec',
      'first_agent_to_agent',
      'previously_denied_pattern',
    ])
  })

  it('every default rule declares a category', () => {
    for (const rule of DEFAULT_RISK_RULES) {
      expect(rule.category).toBeTruthy()
    }
  })

  describe('secret_file_pattern (+50, secret)', () => {
    it.each([
      ['.env', true],
      ['./.env.local', true],
      ['~/.aws/credentials', true],
      ['secrets/server.key', true],
      ['id_rsa', true],
      ['~/.ssh/known_hosts', true],
      ['src/auth.ts', false],
      ['README.md', false],
    ])('path=%s → matches=%s', (path, matches) => {
      const assessment = scorer.assess({
        sourceAgent: 'hermes',
        targetTool: 'read_file',
        args: { path },
      })
      if (matches) {
        const factor = assessment.factors.find(
          (f) => f.rule === 'secret_file_pattern',
        )
        expect(factor).toBeDefined()
        expect(factor!.category).toBe('secret')
        expect(factor!.evidence).toBe(path)
        expect(assessment.totalScore).toBeGreaterThanOrEqual(50)
      } else {
        expect(ruleNames(assessment.factors)).not.toContain(
          'secret_file_pattern',
        )
      }
    })

    it('does not fire when args has no path field', () => {
      const { factors } = scorer.assess({
        sourceAgent: 'hermes',
        targetTool: 'list_files',
        args: { directory: '.env' },
      })
      expect(ruleNames(factors)).not.toContain('secret_file_pattern')
    })
  })

  describe('outbound_network (+30, network)', () => {
    it.each(['fetch', 'http_get', 'https_post', 'wget', 'curl', 'request', 'send_email'])(
      'fires on tool=%s',
      (tool) => {
        const assessment = scorer.assess({
          sourceAgent: 'hermes',
          targetTool: tool,
        })
        const factor = assessment.factors.find(
          (f) => f.rule === 'outbound_network',
        )
        expect(factor).toBeDefined()
        expect(factor!.category).toBe('network')
        expect(assessment.totalScore).toBeGreaterThanOrEqual(30)
      },
    )

    it('does not fire on benign tools', () => {
      const { factors } = scorer.assess({
        sourceAgent: 'hermes',
        targetTool: 'read_file',
      })
      expect(ruleNames(factors)).not.toContain('outbound_network')
    })
  })

  describe('shell_exec (+40, shell)', () => {
    it.each(['shell_exec', 'run_command', 'run_shell', 'bash', 'EXEC'])(
      'fires on tool=%s',
      (tool) => {
        const assessment = scorer.assess({
          sourceAgent: 'hermes',
          targetTool: tool,
        })
        const factor = assessment.factors.find((f) => f.rule === 'shell_exec')
        expect(factor).toBeDefined()
        expect(factor!.category).toBe('shell')
        expect(assessment.totalScore).toBeGreaterThanOrEqual(40)
      },
    )

    it('does not fire on read_file', () => {
      const { factors } = scorer.assess({
        sourceAgent: 'hermes',
        targetTool: 'read_file',
      })
      expect(ruleNames(factors)).not.toContain('shell_exec')
    })
  })

  describe('first_agent_to_agent (+20, structural)', () => {
    it('fires when no prior call to the target agent exists', () => {
      const assessment = scorer.assess({
        sourceAgent: 'hermes',
        targetAgent: 'claude-code',
        targetTool: 'read_file',
        args: { path: 'src/auth.ts' },
      })
      const factor = assessment.factors.find(
        (f) => f.rule === 'first_agent_to_agent',
      )
      expect(factor).toBeDefined()
      expect(factor!.category).toBe('structural')
      expect(assessment.totalScore).toBeGreaterThanOrEqual(20)
    })

    it('does not fire after a recent call to the same target agent', () => {
      seedRequest(db, {
        sourceAgent: 'hermes',
        targetAgent: 'claude-code',
        targetTool: 'read_file',
        createdAt: Date.now() - 30_000,
      })
      const { factors } = scorer.assess({
        sourceAgent: 'hermes',
        targetAgent: 'claude-code',
        targetTool: 'read_file',
      })
      expect(ruleNames(factors)).not.toContain('first_agent_to_agent')
    })

    it('fires again if the prior call was more than an hour ago', () => {
      seedRequest(db, {
        sourceAgent: 'hermes',
        targetAgent: 'claude-code',
        createdAt: Date.now() - 2 * 60 * 60 * 1000,
      })
      const { factors } = scorer.assess({
        sourceAgent: 'hermes',
        targetAgent: 'claude-code',
        targetTool: 'read_file',
      })
      expect(ruleNames(factors)).toContain('first_agent_to_agent')
    })

    it('does not fire when there is no targetAgent', () => {
      const { factors } = scorer.assess({
        sourceAgent: 'hermes',
        targetTool: 'read_file',
      })
      expect(ruleNames(factors)).not.toContain('first_agent_to_agent')
    })
  })

  describe('previously_denied_pattern (+30, structural)', () => {
    it('fires when the same source/tool was denied before', () => {
      seedRequest(db, {
        sourceAgent: 'hermes',
        targetTool: 'read_file',
        decision: 'denied',
      })
      const assessment = scorer.assess({
        sourceAgent: 'hermes',
        targetTool: 'read_file',
      })
      const factor = assessment.factors.find(
        (f) => f.rule === 'previously_denied_pattern',
      )
      expect(factor).toBeDefined()
      expect(factor!.category).toBe('structural')
      expect(assessment.totalScore).toBeGreaterThanOrEqual(30)
    })

    it('does not fire when prior calls were allowed', () => {
      seedRequest(db, {
        sourceAgent: 'hermes',
        targetTool: 'read_file',
        decision: 'allowed',
      })
      const { factors } = scorer.assess({
        sourceAgent: 'hermes',
        targetTool: 'read_file',
      })
      expect(ruleNames(factors)).not.toContain('previously_denied_pattern')
    })
  })

  describe('composite assessment', () => {
    it('.env read from a fresh agent-to-agent pair scores 70 → high bucket → ask', () => {
      const assessment = scorer.assess({
        sourceAgent: 'hermes',
        targetAgent: 'claude-code',
        targetTool: 'read_file',
        args: { path: '.env' },
      })
      expect(ruleNames(assessment.factors)).toEqual(
        expect.arrayContaining(['secret_file_pattern', 'first_agent_to_agent']),
      )
      expect(assessment.totalScore).toBe(70)
      expect(assessment.bucket).toBe('high')
      expect(assessment.recommendation).toBe('ask')
    })

    it('benign read after a prior allow primes the agent pair → low / allow', () => {
      seedRequest(db, {
        sourceAgent: 'claude-code',
        targetAgent: 'fs',
        createdAt: Date.now() - 10_000,
      })
      const assessment = scorer.assess({
        sourceAgent: 'claude-code',
        targetAgent: 'fs',
        targetTool: 'read_file',
        args: { path: 'src/auth.ts' },
      })
      expect(assessment.totalScore).toBe(0)
      expect(assessment.factors).toEqual([])
      expect(assessment.bucket).toBe('low')
      expect(assessment.recommendation).toBe('allow')
    })

    it('accepts a custom rule set returning multi-factor arrays', () => {
      const customRule: RiskRule = {
        name: 'always_high',
        category: 'structural',
        evaluate: () => [
          {
            rule: 'always_high_a',
            category: 'structural',
            points: 60,
            reason: 'test a',
          },
          {
            rule: 'always_high_b',
            category: 'structural',
            points: 30,
            reason: 'test b',
          },
        ],
      }
      const custom = new RiskScorer(db, [customRule])
      const assessment = custom.assess({ sourceAgent: 'x', targetTool: 'y' })
      expect(assessment.totalScore).toBe(90)
      expect(assessment.bucket).toBe('critical')
      expect(ruleNames(assessment.factors)).toEqual([
        'always_high_a',
        'always_high_b',
      ])
    })

    it('a rule emitting zero factors does not contribute', () => {
      const noop: RiskRule = {
        name: 'noop',
        category: 'structural',
        evaluate: () => [],
      }
      const custom = new RiskScorer(db, [noop])
      const assessment = custom.assess({ sourceAgent: 'x', targetTool: 'y' })
      expect(assessment.factors).toEqual([])
      expect(assessment.totalScore).toBe(0)
    })

    it('llmVerification defaults to null (C8 has not run)', () => {
      const assessment = scorer.assess({ sourceAgent: 'hermes' })
      expect(assessment.llmVerification).toBeNull()
    })
  })
})

describe('bucketFor / recommendationFor / composeAssessment', () => {
  it.each([
    [0, 'low'],
    [15, 'low'],
    [29, 'low'],
    [30, 'medium'],
    [50, 'medium'],
    [59, 'medium'],
    [60, 'high'],
    [84, 'high'],
    [85, 'critical'],
    [100, 'critical'],
  ])('score=%i → bucket=%s', (score, bucket) => {
    expect(bucketFor(score)).toBe(bucket)
  })

  it('clamps negative scores to low', () => {
    const assessment = composeAssessment([
      {
        rule: 'safe',
        category: 'structural',
        points: -50,
        reason: 'known-good caller',
      },
    ])
    expect(assessment.totalScore).toBe(0)
    expect(assessment.bucket).toBe('low')
  })

  it('clamps scores above 100', () => {
    const assessment = composeAssessment([
      {
        rule: 'huge',
        category: 'secret',
        points: 250,
        reason: 'test',
      },
    ])
    expect(assessment.totalScore).toBe(100)
    expect(assessment.bucket).toBe('critical')
  })

  it('safe-list negative points can pull a high score back into medium', () => {
    const assessment = composeAssessment([
      { rule: 'a', category: 'secret', points: 70, reason: 'secret-y' },
      { rule: 'safe', category: 'structural', points: -25, reason: 'known good' },
    ])
    expect(assessment.totalScore).toBe(45)
    expect(assessment.bucket).toBe('medium')
  })

  it('default recommendations follow the spec table', () => {
    expect(recommendationFor('low')).toBe('allow')
    expect(recommendationFor('medium')).toBe('ask')
    expect(recommendationFor('high')).toBe('ask')
    expect(recommendationFor('critical')).toBe('ask')
  })

  it('bucket overrides win over defaults', () => {
    expect(recommendationFor('critical', { critical: 'deny' })).toBe('deny')
    expect(recommendationFor('medium', { medium: 'allow' })).toBe('allow')
    expect(recommendationFor('high', { critical: 'deny' })).toBe('ask')
  })

  it('composeAssessment threads overrides through to the recommendation', () => {
    const assessment = composeAssessment(
      [{ rule: 'r', category: 'shell', points: 90, reason: 'critical' }],
      { critical: 'deny' },
    )
    expect(assessment.bucket).toBe('critical')
    expect(assessment.recommendation).toBe('deny')
  })

  it('empty factor list → low / allow', () => {
    const assessment = composeAssessment([])
    expect(assessment.totalScore).toBe(0)
    expect(assessment.bucket).toBe('low')
    expect(assessment.recommendation).toBe('allow')
    expect(assessment.llmVerification).toBeNull()
  })
})
