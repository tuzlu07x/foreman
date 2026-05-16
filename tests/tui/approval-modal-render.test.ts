import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import type { ApprovalRequest } from '../../src/core/approval.js'
import type {
  RiskBucket,
  RiskFactor,
} from '../../src/core/risk-rules/types.js'
import { ApprovalModal } from '../../src/tui/components/approval-modal.js'

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: 'req-1',
    sourceAgent: 'hermes',
    targetAgent: 'claude-code',
    targetTool: 'read_file',
    args: { path: '.env' },
    riskScore: 80,
    riskReasons: ['secret_path', 'first_agent_to_agent'],
    riskFactors: [
      {
        rule: 'secret_path',
        category: 'secret',
        points: 60,
        reason: '.env-style file (likely contains API keys / secrets)',
        evidence: '".env',
      },
      {
        rule: 'first_agent_to_agent',
        category: 'structural',
        points: 20,
        reason: 'first hermes → claude-code call in the last hour',
      },
    ],
    riskBucket: 'high',
    llmVerification: null,
    ...overrides,
  }
}

describe('ApprovalModal — bucket-coloured border + grouped factor view', () => {
  it.each<[RiskBucket, string]>([
    ['low', 'LOW RISK'],
    ['medium', 'MEDIUM RISK'],
    ['high', 'HIGH RISK'],
    ['critical', 'CRITICAL RISK'],
  ])('renders %s bucket header → %s', (bucket, headerLabel) => {
    const { lastFrame } = render(
      React.createElement(ApprovalModal, {
        request: makeRequest({ riskBucket: bucket }),
        remainingSeconds: 45,
      }),
    )
    const frame = stripAnsi(lastFrame() ?? '')
    expect(frame).toContain(headerLabel)
  })

  it('groups factors by category — both groups + total points visible', () => {
    const { lastFrame } = render(
      React.createElement(ApprovalModal, {
        request: makeRequest(),
        remainingSeconds: 45,
      }),
    )
    const frame = stripAnsi(lastFrame() ?? '')
    // Secret group: 60 pts from secret_path
    expect(frame).toContain('Secret-related')
    expect(frame).toContain('+60')
    // Structural group: 20 pts from first_agent_to_agent
    expect(frame).toContain('Structural')
    expect(frame).toContain('+20')
    // Per-factor reasons render too
    expect(frame).toContain('.env-style file')
    expect(frame).toContain('first hermes → claude-code call')
  })

  it('renders evidence below the factor when present (truncated to one line)', () => {
    const { lastFrame } = render(
      React.createElement(ApprovalModal, {
        request: makeRequest({
          riskFactors: [
            {
              rule: 'secret_shape',
              category: 'secret',
              points: 60,
              reason: 'Anthropic API key in args (sk-ant-a…TAIL)',
              evidence: 'Anthropic API key',
            },
          ],
        }),
        remainingSeconds: 45,
      }),
    )
    const frame = stripAnsi(lastFrame() ?? '')
    expect(frame).toContain('↳ Anthropic API key')
  })

  it('shows source → target flow + tool + arg snippet', () => {
    const { lastFrame } = render(
      React.createElement(ApprovalModal, {
        request: makeRequest(),
        remainingSeconds: 45,
      }),
    )
    const frame = stripAnsi(lastFrame() ?? '')
    expect(frame).toContain('hermes')
    expect(frame).toContain('claude-code')
    expect(frame).toContain('read_file')
    expect(frame).toContain('".env"')
  })

  it('falls back to flat reason list when factors are empty (legacy payload)', () => {
    const { lastFrame } = render(
      React.createElement(ApprovalModal, {
        request: makeRequest({
          riskFactors: [],
          riskReasons: ['secret_file_pattern'],
        }),
        remainingSeconds: 45,
      }),
    )
    const frame = stripAnsi(lastFrame() ?? '')
    expect(frame).toContain('Reasons:')
    expect(frame).toContain('secret_file_pattern')
  })

  it('shows timer + hotkey row in every render', () => {
    const { lastFrame } = render(
      React.createElement(ApprovalModal, {
        request: makeRequest(),
        remainingSeconds: 12,
      }),
    )
    const frame = stripAnsi(lastFrame() ?? '')
    expect(frame).toContain('12s left')
    // Hotkeys are rendered with bracketed first letter ("[a]llow once") so
    // assert on the partial after the bracket.
    expect(frame).toContain(']llow once')
    expect(frame).toContain(']eny')
    expect(frame).toContain(']nspect')
  })

  it('renders factors with negative points (safe-list) using the minus sign', () => {
    const { lastFrame } = render(
      React.createElement(ApprovalModal, {
        request: makeRequest({
          riskFactors: [
            {
              rule: 'secret_path',
              category: 'secret',
              points: 50,
              reason: 'k8s/cloud service-account credentials JSON',
              evidence: 'credentials.json',
            },
            {
              rule: 'safe_list_docs',
              category: 'secret',
              points: -10,
              reason: 'README file',
            },
          ],
          riskScore: 40,
          riskBucket: 'medium',
        }),
        remainingSeconds: 30,
      }),
    )
    const frame = stripAnsi(lastFrame() ?? '')
    expect(frame).toContain('-10')
    expect(frame).toContain('README file')
    expect(frame).toContain('MEDIUM RISK')
  })

  it('renders the double-line border around the modal body', () => {
    const { lastFrame } = render(
      React.createElement(ApprovalModal, {
        request: makeRequest(),
        remainingSeconds: 45,
      }),
    )
    const frame = lastFrame() ?? ''
    // Ink's double-style border chars (╔ ╗ ╚ ╝ ║ ═). Just check a corner.
    expect(frame).toMatch(/[╔╗╚╝]/)
  })
})
