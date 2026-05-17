import { describe, expect, it } from 'vitest'
import type { ForemanEventMap } from '../../../src/core/event-bus.js'
import {
  levelForBucket,
  renderApprovalNotification,
  renderResolvedFooter,
} from '../../../src/core/notification/render.js'
import type { RiskFactor } from '../../../src/core/risk-rules/types.js'

function factor(
  overrides: Partial<RiskFactor> = {},
): RiskFactor {
  return {
    rule: 'secret_path',
    category: 'secret',
    points: 60,
    reason: '.env-style file detected',
    ...overrides,
  }
}

function approvalEvent(
  overrides: Partial<ForemanEventMap['approval:requested']> = {},
): ForemanEventMap['approval:requested'] {
  return {
    requestId: 'r-1',
    sourceAgent: 'hermes',
    targetAgent: 'claude-code',
    targetTool: 'read_file',
    args: { path: '.env' },
    riskScore: 80,
    riskReasons: ['secret_path', 'first_agent_to_agent'],
    riskFactors: [
      factor({ rule: 'secret_path', category: 'secret', points: 60, reason: '.env-style file' }),
      factor({
        rule: 'first_agent_to_agent',
        category: 'structural',
        points: 20,
        reason: 'first hermes → claude-code call',
      }),
    ],
    riskBucket: 'high',
    llmVerification: null,
    securityReport: null,
    sessionId: 'sess-1',
    ...overrides,
  }
}

describe('levelForBucket', () => {
  it.each([
    ['critical', 'critical'],
    ['high', 'critical'],
    ['medium', 'warning'],
    ['low', 'info'],
  ] as const)('%s bucket → %s notification level', (bucket, level) => {
    expect(levelForBucket(bucket)).toBe(level)
  })
})

describe('renderApprovalNotification', () => {
  it('maps a high-bucket approval into a critical-level notification', () => {
    const n = renderApprovalNotification(approvalEvent())
    expect(n.level).toBe('critical')
    expect(n.requestId).toBe('r-1')
    expect(n.agentBlocking).toBe(true)
  })

  it('builds a title with bucket + flow + tool', () => {
    const n = renderApprovalNotification(approvalEvent())
    expect(n.title).toContain('[HIGH]')
    expect(n.title).toContain('hermes → claude-code')
    expect(n.title).toContain('read_file')
  })

  it('omits the target arrow when only sourceAgent is present', () => {
    const n = renderApprovalNotification(
      approvalEvent({ targetAgent: undefined, targetTool: undefined }),
    )
    expect(n.title).toContain('hermes')
    expect(n.title).not.toContain('→')
    expect(n.title).toContain('(no tool)')
  })

  it('groups factors by category in the body with totals', () => {
    const n = renderApprovalNotification(approvalEvent())
    expect(n.body).toContain('Risk score: 80/100 (high)')
    expect(n.body).toContain('Secret-related (+60 pts)')
    expect(n.body).toContain('+60  .env-style file')
    expect(n.body).toContain('Structural (+20 pts)')
    expect(n.body).toContain('+20  first hermes → claude-code call')
  })

  it('falls back to flat reasons when factors are empty', () => {
    const n = renderApprovalNotification(
      approvalEvent({
        riskFactors: [],
        riskReasons: ['secret_file_pattern'],
      }),
    )
    expect(n.body).toContain('Reasons:')
    expect(n.body).toContain('secret_file_pattern')
  })

  it('uses the policy-ask-no-factor fallback when both are empty', () => {
    const n = renderApprovalNotification(
      approvalEvent({ riskFactors: [], riskReasons: [] }),
    )
    expect(n.body).toContain('no specific factors')
  })

  it('renders truncated args when args.path is present', () => {
    const n = renderApprovalNotification(approvalEvent())
    expect(n.body).toContain('Args:')
    expect(n.body).toContain('.env')
  })

  it('truncates very long args to <= 200 chars', () => {
    const longPath = '/very/long/'.repeat(50)
    const n = renderApprovalNotification(
      approvalEvent({ args: { path: longPath } }),
    )
    const argsLine = n.body.split('\n').find((l) => l.startsWith('Args:'))!
    expect(argsLine.length).toBeLessThan(220)
    expect(argsLine.endsWith('…')).toBe(true)
  })

  it('critical bucket gets the full action ladder (allow / deny / deny_always / inspect)', () => {
    const n = renderApprovalNotification(
      approvalEvent({ riskBucket: 'critical' }),
    )
    const ids = n.actions.map((a) => a.id)
    expect(ids).toEqual(['allow', 'deny', 'deny_always', 'inspect'])
  })

  it('high bucket gets allow + deny + inspect (no deny_always)', () => {
    const n = renderApprovalNotification(approvalEvent({ riskBucket: 'high' }))
    const ids = n.actions.map((a) => a.id)
    expect(ids).toEqual(['allow', 'deny', 'inspect'])
  })

  it('medium bucket gets just allow + deny', () => {
    const n = renderApprovalNotification(
      approvalEvent({ riskBucket: 'medium' }),
    )
    const ids = n.actions.map((a) => a.id)
    expect(ids).toEqual(['allow', 'deny'])
  })
})

describe('renderResolvedFooter', () => {
  it('marks a user-allowed resolution with ✓', () => {
    const out = renderResolvedFooter({
      requestId: 'r-1',
      decision: 'allowed',
      resolvedBy: 'user',
    })
    expect(out).toContain('✓ Allowed')
    expect(out).toContain('elsewhere')
  })

  it('marks a denied resolution with ✗', () => {
    const out = renderResolvedFooter({
      requestId: 'r-1',
      decision: 'denied',
      resolvedBy: 'user',
    })
    expect(out).toContain('✗ Denied')
  })

  it('flags timeout-driven resolutions as such', () => {
    const out = renderResolvedFooter({
      requestId: 'r-1',
      decision: 'denied',
      resolvedBy: 'timeout',
    })
    expect(out).toContain('timeout default')
  })
})
