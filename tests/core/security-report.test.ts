import { describe, expect, it } from 'vitest'
import { generateReport } from '../../src/core/security-report.js'
import type {
  LlmVerification,
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

function llm(over: Partial<LlmVerification> = {}): LlmVerification {
  return {
    is_real_threat: true,
    threat_type: 'credential_theft',
    confidence: 0.9,
    explanation_short: 'reads a credential file',
    explanation_long: 'The agent is reading a file that appears to contain API keys.',
    recommended_action: 'deny',
    additional_risk_score: 10,
    user_should_check: ['Did you initiate this just now?'],
    provider: 'anthropic',
    model: 'claude-haiku',
    costUsd: 0.0001,
    latencyMs: 120,
    fromCache: false,
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

describe('generateReport — Path A (LLM verified)', () => {
  it('marks high-confidence real threat with deny → critical severity + 🔴', () => {
    const report = generateReport({
      sourceAgent: 'hermes',
      targetTool: 'read_file',
      args: { path: '.env' },
      assessment: assessment({ llmVerification: llm() }),
    })
    expect(report.source).toBe('llm_verified')
    expect(report.verdict.severity).toBe('critical')
    expect(report.verdict.icon).toBe('🔴')
    expect(report.verdict.label).toContain('Credential Theft')
    expect(report.narrative.recommendation).toBe('deny')
    expect(report.narrative.whatHappening).toContain('API keys')
    expect(report.technical.llmAdjustment).toBe(10)
  })

  it('uses ask → high severity + 🟠 when LLM recommends ask', () => {
    const report = generateReport({
      sourceAgent: 'hermes',
      args: {},
      assessment: assessment({
        llmVerification: llm({ recommended_action: 'ask' }),
      }),
    })
    expect(report.verdict.severity).toBe('high')
    expect(report.verdict.icon).toBe('🟠')
    expect(report.verdict.label).toContain('RISKY')
  })

  it('confidence < 0.7 forces uncertain regardless of recommendation', () => {
    const report = generateReport({
      sourceAgent: 'hermes',
      args: {},
      assessment: assessment({
        llmVerification: llm({ confidence: 0.4, recommended_action: 'deny' }),
      }),
    })
    expect(report.verdict.severity).toBe('uncertain')
    expect(report.verdict.icon).toBe('🟠')
    expect(report.verdict.label).toContain('UNCERTAIN')
  })

  it('not-a-threat verdict → likely_legitimate + 🟡', () => {
    const report = generateReport({
      sourceAgent: 'hermes',
      args: {},
      assessment: assessment({
        llmVerification: llm({
          is_real_threat: false,
          recommended_action: 'allow',
          threat_type: 'false_positive',
        }),
      }),
    })
    expect(report.verdict.severity).toBe('likely_legitimate')
    expect(report.verdict.icon).toBe('🟡')
  })

  it('falls back to placeholder check when LLM returns empty user_should_check', () => {
    const report = generateReport({
      sourceAgent: 'hermes',
      args: {},
      assessment: assessment({
        llmVerification: llm({ user_should_check: [] }),
      }),
    })
    expect(report.narrative.thingsToCheck).toEqual(['No specific items flagged.'])
  })
})

describe('generateReport — Path B (heuristic-only)', () => {
  it('feature_disabled skipped reason → llm_disabled source', () => {
    const report = generateReport({
      sourceAgent: 'hermes',
      args: {},
      assessment: assessment({
        llmVerification: llm({ skipped: 'feature_disabled' }),
      }),
    })
    expect(report.source).toBe('llm_disabled')
    expect(report.narrative.whatHappening).toContain('Smart analysis is off')
  })

  it('budget_exhausted → llm_budget_exhausted source + paused footer', () => {
    const report = generateReport({
      sourceAgent: 'hermes',
      args: {},
      assessment: assessment({
        llmVerification: llm({ skipped: 'budget_exhausted' }),
      }),
    })
    expect(report.source).toBe('llm_budget_exhausted')
    expect(report.narrative.whatHappening).toContain('paused')
  })

  it('llm_error → llm_failed_fallback source', () => {
    const report = generateReport({
      sourceAgent: 'hermes',
      args: {},
      assessment: assessment({
        llmVerification: llm({ skipped: 'llm_error' }),
      }),
    })
    expect(report.source).toBe('llm_failed_fallback')
    expect(report.narrative.whatHappening).toContain('temporarily unavailable')
  })

  it('no llmVerification → heuristic_only source', () => {
    const report = generateReport({
      sourceAgent: 'hermes',
      args: {},
      assessment: assessment(),
    })
    expect(report.source).toBe('heuristic_only')
    expect(report.verdict.severity).toBe('high')
    expect(report.verdict.icon).toBe('🟠')
  })

  it('bucket-derived recommendation mirrors heuristic bucket', () => {
    const lowReport = generateReport({
      sourceAgent: 'hermes',
      args: {},
      assessment: assessment({ bucket: 'low', totalScore: 10 }),
    })
    expect(lowReport.narrative.recommendation).toBe('allow')

    const criticalReport = generateReport({
      sourceAgent: 'hermes',
      args: {},
      assessment: assessment({ bucket: 'critical', totalScore: 95 }),
    })
    expect(criticalReport.narrative.recommendation).toBe('ask')
  })
})

describe('generateReport — one-line summary', () => {
  it('renders "X wants Y to tool(...)" for agent-to-agent', () => {
    const report = generateReport({
      sourceAgent: 'hermes',
      sourceResponsibility: 'personal assistant',
      targetAgent: 'claude-code',
      targetTool: 'read_file',
      args: { path: 'src/auth.ts' },
      assessment: assessment(),
    })
    expect(report.oneLineSummary).toBe(
      'hermes [personal assistant] wants claude-code to read_file src/auth.ts',
    )
  })

  it('drops target-agent for direct-tool calls', () => {
    const report = generateReport({
      sourceAgent: 'hermes',
      targetTool: 'bash',
      args: { cmd: 'ls' },
      assessment: assessment(),
    })
    expect(report.oneLineSummary).toBe('hermes wants to bash: ls')
  })
})

describe('generateReport — technical layer', () => {
  it('separates heuristic from LLM adjustment', () => {
    const report = generateReport({
      sourceAgent: 'hermes',
      args: {},
      assessment: assessment({
        totalScore: 80,
        llmVerification: llm({ additional_risk_score: 15 }),
      }),
    })
    expect(report.technical.heuristicScore).toBe(65)
    expect(report.technical.llmAdjustment).toBe(15)
    expect(report.technical.finalScore).toBe(80)
  })

  it('reports null llmAdjustment when LLM did not run', () => {
    const report = generateReport({
      sourceAgent: 'hermes',
      args: {},
      assessment: assessment(),
    })
    expect(report.technical.llmAdjustment).toBeNull()
    expect(report.technical.heuristicScore).toBe(70)
  })
})
