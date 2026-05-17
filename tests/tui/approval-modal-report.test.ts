import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import type { ApprovalRequest } from '../../src/core/approval.js'
import type { SecurityReport } from '../../src/core/security-report.js'
import { ApprovalModal } from '../../src/tui/components/approval-modal.js'

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

function buildReport(over: Partial<SecurityReport> = {}): SecurityReport {
  return {
    oneLineSummary: 'hermes wants claude-code to read_file .env',
    verdict: {
      severity: 'critical',
      confidence: 0.9,
      icon: '🔴',
      label: 'LIKELY THREAT — Credential Theft (confidence 90%)',
      threatType: 'credential_theft',
    },
    narrative: {
      whatHappening: 'The agent appears to be reading a credential file.',
      thingsToCheck: [
        'Did you initiate this action just now?',
        'Is the path a real secret?',
      ],
      recommendation: 'deny',
    },
    technical: {
      factors: [
        {
          rule: 'secret_path',
          category: 'secret',
          points: 60,
          reason: '.env-style file detected',
          evidence: '.env',
        },
      ],
      heuristicScore: 70,
      llmAdjustment: 10,
      finalScore: 80,
      bucket: 'high',
    },
    source: 'llm_verified',
    reportLatencyMs: 12,
    ...over,
  }
}

function buildRequest(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: 'req-1',
    sourceAgent: 'hermes',
    targetAgent: 'claude-code',
    targetTool: 'read_file',
    args: { path: '.env' },
    riskScore: 80,
    riskReasons: ['secret_path'],
    riskFactors: [
      {
        rule: 'secret_path',
        category: 'secret',
        points: 60,
        reason: '.env-style file detected',
        evidence: '.env',
      },
    ],
    riskBucket: 'high',
    llmVerification: null,
    securityReport: buildReport(),
    ...over,
  }
}

function renderModal(
  request: ApprovalRequest,
  technicalExpanded = false,
  remainingSeconds = 30,
): string {
  const { lastFrame } = render(
    React.createElement(ApprovalModal, {
      request,
      remainingSeconds,
      technicalExpanded,
    }),
  )
  return stripAnsi(lastFrame() ?? '')
}

describe('ApprovalModal — 3-layer report rendering', () => {
  it('renders verdict, summary, narrative, recommendation, footer', () => {
    const out = renderModal(buildRequest(), false, 42)
    expect(out).toContain('LIKELY THREAT — Credential Theft')
    expect(out).toContain('hermes wants claude-code to read_file .env')
    expect(out).toContain("What's happening")
    expect(out).toContain('The agent appears to be reading a credential file.')
    expect(out).toContain('Things to check')
    expect(out).toContain('Did you initiate this action just now?')
    expect(out).toContain('foreman → deny')
    expect(out).toContain('Press [t] for technical detail')
    expect(out).toContain('Smart analysis: contextual verification ran')
    expect(out).toContain('42s left')
  })

  it('expands technical detail when technicalExpanded=true', () => {
    const out = renderModal(buildRequest(), true)
    expect(out).toContain('Technical detail')
    expect(out).toContain('heuristic 70')
    expect(out).toContain('LLM +10')
    expect(out).toContain('final 80/100')
    expect(out).toContain('Secret-related')
    expect(out).not.toContain('Press [t] for technical detail')
  })

  it('shows llm_disabled footer for that source variant', () => {
    const out = renderModal(
      buildRequest({
        securityReport: buildReport({ source: 'llm_disabled' }),
      }),
    )
    expect(out).toContain('Smart analysis is off')
    expect(out).toContain('foreman llm enable')
  })

  it('shows llm_budget_exhausted paused footer', () => {
    const out = renderModal(
      buildRequest({
        securityReport: buildReport({ source: 'llm_budget_exhausted' }),
      }),
    )
    expect(out).toContain('Smart analysis paused')
  })

  it('shows llm_failed_fallback temporarily-unavailable footer', () => {
    const out = renderModal(
      buildRequest({
        securityReport: buildReport({ source: 'llm_failed_fallback' }),
      }),
    )
    expect(out).toContain('temporarily unavailable')
  })

  it('shows heuristic_only "enable LLM" footer', () => {
    const out = renderModal(
      buildRequest({
        securityReport: buildReport({ source: 'heuristic_only' }),
      }),
    )
    expect(out).toContain('Heuristic-only report')
  })

  it('renders [t]echnical hotkey hint when collapsed', () => {
    const out = renderModal(buildRequest(), false)
    expect(out).toContain('[t]echnical')
  })

  it('renders [t]hide when expanded', () => {
    const out = renderModal(buildRequest(), true)
    expect(out).toContain('[t]hide')
  })

  it('falls back to legacy modal when securityReport is null', () => {
    const out = renderModal(buildRequest({ securityReport: null }))
    expect(out).toContain('HIGH RISK')
    expect(out).not.toContain("What's happening")
    expect(out).not.toContain('[t]')
  })
})
