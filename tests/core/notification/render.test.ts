import { describe, expect, it } from 'vitest'
import type { ForemanEventMap } from '../../../src/core/event-bus.js'
import {
  formatCountdownLine,
  formatElapsed,
  formatRemaining,
  levelForBucket,
  renderApprovalNotification,
  renderResolvedFooter,
  renderSessionCompleted,
  renderSessionProgress,
  renderSessionStarted,
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

  // Helper — strip `block_*` custom actions (#526) so bucket assertions
  // focus on the standard ladder. Custom buttons depend on the request's
  // risk factors, not the bucket itself; they're covered in a separate
  // describe block below.
  const standardIds = (actions: { id: string }[]): string[] =>
    actions.map((a) => a.id).filter((id) => !id.startsWith('block_'))

  it('critical bucket gets the full action ladder (allow / deny / deny_always / inspect)', () => {
    const n = renderApprovalNotification(
      approvalEvent({ riskBucket: 'critical' }),
    )
    expect(standardIds(n.actions)).toEqual([
      'allow',
      'deny',
      'deny_always',
      'inspect',
    ])
  })

  it('high bucket gets allow + deny + inspect (no deny_always)', () => {
    const n = renderApprovalNotification(approvalEvent({ riskBucket: 'high' }))
    expect(standardIds(n.actions)).toEqual(['allow', 'deny', 'inspect'])
  })

  it('medium bucket gets just allow + deny', () => {
    const n = renderApprovalNotification(
      approvalEvent({ riskBucket: 'medium' }),
    )
    expect(standardIds(n.actions)).toEqual(['allow', 'deny'])
  })
})

// =============================================================================
// #526 — Custom "block this pattern" actions.
//
// When the request hit a recognisable risk factor (secret_path, shell
// destructive, network exfil, …) the modal offers a one-tap button to
// inject a permanent deny rule alongside the standard ladder. These
// tests pin the button shape so the agent SOUL + the policy injector
// stay in sync.
// =============================================================================
describe('renderApprovalNotification — custom policy-injection actions (#526)', () => {
  it('offers a block_secret_path button when the secret_path factor matched', () => {
    const n = renderApprovalNotification(
      approvalEvent({
        targetTool: 'read_file',
        args: { path: '.env' },
        riskFactors: [
          factor({
            rule: 'secret_path',
            category: 'secret',
            points: 60,
            reason: '.env-style file',
          }),
        ],
      }),
    )
    const custom = n.actions.find((a) => a.id === 'block_secret_path')
    expect(custom).toBeDefined()
    expect(custom!.intent).toBe('custom')
    expect(custom!.style).toBe('danger')
    expect(custom!.label).toContain('.env*')
    expect(custom!.label).toContain('hermes')
    expect(custom!.payload).toMatchObject({
      action: 'add-deny-rule',
      sourceAgent: 'hermes',
      target: 'tool:read_file',
      reason: 'secret_path',
    })
    expect(
      (custom!.payload as { predicate?: { pathMatch?: string[] } }).predicate?.pathMatch,
    ).toEqual(['\\.env(\\..*)?$'])
  })

  it('omits custom buttons when no factor produces a clean predicate', () => {
    const n = renderApprovalNotification(
      approvalEvent({
        targetTool: 'read_file',
        args: { path: '.env' },
        riskFactors: [
          factor({
            rule: 'first_agent_to_agent',
            category: 'structural',
            points: 20,
            reason: 'first hermes → claude-code call',
          }),
        ],
      }),
    )
    expect(n.actions.find((a) => a.id.startsWith('block_'))).toBeUndefined()
  })

  it('omits custom buttons when targetTool is absent (no binding possible)', () => {
    const n = renderApprovalNotification(
      approvalEvent({
        targetTool: undefined,
        riskFactors: [
          factor({
            rule: 'secret_path',
            category: 'secret',
            points: 60,
            reason: '.env',
          }),
        ],
      }),
    )
    expect(n.actions.find((a) => a.id.startsWith('block_'))).toBeUndefined()
  })

  it('dedupes by actionId so two factors with the same rule produce one button', () => {
    const n = renderApprovalNotification(
      approvalEvent({
        targetTool: 'read_file',
        args: { path: '.env' },
        riskFactors: [
          factor({ rule: 'secret_path', category: 'secret', points: 60, reason: 'a' }),
          factor({ rule: 'secret_path', category: 'secret', points: 60, reason: 'b' }),
        ],
      }),
    )
    const matches = n.actions.filter((a) => a.id === 'block_secret_path')
    expect(matches).toHaveLength(1)
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

// =============================================================================
// #523 — Session lifecycle renderers.
//
// Templates carry the Turkish scenario tone — the same shape the daily
// summary uses. Tests pin the user-visible fragments so a future template
// tweak doesn't silently break the scenario.
// =============================================================================

describe('renderSessionStarted (#523)', () => {
  it('joins participants with " + " and labels with the trigger', () => {
    const n = renderSessionStarted({
      sessionId: 'sess-abc',
      participants: ['openclaw', 'hermes'],
      trigger: 'user_command:write',
      startedAt: 1_700_000_000_000,
    })
    expect(n.level).toBe('session_lifecycle')
    expect(n.actions).toEqual([])
    expect(n.agentBlocking).toBe(false)
    expect(n.body).toContain('▶️ openclaw + hermes çalışmaya başladı.')
    expect(n.body).toContain('Trigger: user_command:write')
  })

  it('renders the estimated-turn hint when the planner provides one', () => {
    const n = renderSessionStarted({
      sessionId: 'sess-abc',
      participants: ['a'],
      trigger: 't',
      estimatedTurns: 8,
      startedAt: 0,
    })
    expect(n.body).toContain('Plan: 8 turn')
  })

  it('omits the plan line when estimatedTurns is absent', () => {
    const n = renderSessionStarted({
      sessionId: 'sess-abc',
      participants: ['a'],
      trigger: 't',
      startedAt: 0,
    })
    expect(n.body).not.toContain('Plan:')
  })
})

describe('renderSessionProgress (#523)', () => {
  it('uses the first 6 chars of the sessionId as a stable short label', () => {
    const n = renderSessionProgress({
      sessionId: '01HZX4N5YJK2P8Q3R6V7T9W2WB',
      turnCount: 14,
      tokenCount: 12_345,
      recentDecisions: [],
      elapsedMs: 78 * 60 * 1000,
      emittedAt: 0,
    })
    expect(n.title).toContain('01HZX4')
    expect(n.body).toContain('14 turn')
    expect(n.body).toContain('12,345 token')
    expect(n.body).toContain('1h 18m')
  })

  it('quotes the most recent decision when one is present', () => {
    const n = renderSessionProgress({
      sessionId: 'sess-abc-12345',
      turnCount: 3,
      tokenCount: 500,
      recentDecisions: [
        {
          sourceAgent: 'hermes',
          targetTool: 'read_file',
          decision: 'allowed',
        },
        { sourceAgent: 'old', targetTool: 'older', decision: 'allowed' },
      ],
      elapsedMs: 30_000,
      emittedAt: 0,
    })
    expect(n.body).toContain('Son: hermes → read_file')
  })

  it('falls back to targetAgent when targetTool is absent', () => {
    const n = renderSessionProgress({
      sessionId: 'sess-abc-12345',
      turnCount: 1,
      tokenCount: 0,
      recentDecisions: [
        {
          sourceAgent: 'openclaw',
          targetAgent: 'claude-code',
          decision: 'allowed',
        },
      ],
      elapsedMs: 5_000,
      emittedAt: 0,
    })
    expect(n.body).toContain('Son: openclaw → claude-code')
  })

  it('omits the "Son:" line when there are no recent decisions yet', () => {
    const n = renderSessionProgress({
      sessionId: 'sess-abc-12345',
      turnCount: 0,
      tokenCount: 0,
      recentDecisions: [],
      elapsedMs: 5_000,
      emittedAt: 0,
    })
    expect(n.body).not.toContain('Son:')
  })
})

describe('renderSessionCompleted (#523)', () => {
  it('renders the success outcome with ✓ + cost + duration', () => {
    const n = renderSessionCompleted({
      sessionId: 'sess-abc-12345',
      outcome: 'success',
      turnCount: 4,
      tokenCount: 1500,
      costUsd: 0.04,
      durationMs: 23_000,
      completedAt: 0,
    })
    expect(n.body).toContain('✓ sess-a success')
    expect(n.body).toContain('4 turn · 23s · $0.04')
    expect(n.body).not.toContain('Sebep:')
  })

  it('renders non-success outcomes with ⚠ and the reason', () => {
    const n = renderSessionCompleted({
      sessionId: 'sess-abc-12345',
      outcome: 'halted',
      reason: 'token_limit',
      turnCount: 12,
      tokenCount: 100_000,
      costUsd: 0.42,
      durationMs: 5 * 60 * 1000,
      completedAt: 0,
    })
    expect(n.body).toContain('⚠ sess-a halted')
    expect(n.body).toContain('Sebep: token_limit')
  })

  it('still reports $0.00 when costUsd is 0 (placeholder before #530)', () => {
    const n = renderSessionCompleted({
      sessionId: 'sess-abc-12345',
      outcome: 'success',
      turnCount: 1,
      tokenCount: 10,
      costUsd: 0,
      durationMs: 1000,
      completedAt: 0,
    })
    expect(n.body).toContain('$0.00')
  })
})

describe('formatElapsed (#523)', () => {
  it.each([
    [0, '0s'],
    [999, '0s'],
    [1000, '1s'],
    [59_000, '59s'],
    [60_000, '1m'],
    [90_000, '1m 30s'],
    [60 * 60 * 1000, '1h'],
    [78 * 60 * 1000, '1h 18m'],
    [24 * 60 * 60 * 1000, '24h'],
  ])('formats %i ms as %s', (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected)
  })

  it('clamps negative durations to 0s (clock skew safety)', () => {
    expect(formatElapsed(-500)).toBe('0s')
  })
})

// =============================================================================
// #525 — Approval countdown helpers.
//
// formatRemaining is the building block (pure conversion); formatCountdownLine
// composes the user-facing tail with "Auto-{decision} in …" + the "tap [Deny]
// to block now" nudge. Tests pin the user-visible fragments so the per-minute
// ticker edits stay reproducible across CI / local runs.
// =============================================================================

describe('formatRemaining (#525)', () => {
  it.each([
    [0, '0s'],
    [-100, '0s'],
    [500, '0s'],
    [1000, '1s'],
    [59_000, '59s'],
    [60_000, '1m'],
    [60_500, '1m'],
    [90_000, '1m 30s'],
    [5 * 60_000, '5m'],
    [5 * 60_000 + 17_000, '5m 17s'],
    [10 * 60_000, '10m'],
  ])('formats %i ms as %s', (ms, expected) => {
    expect(formatRemaining(ms)).toBe(expected)
  })
})

describe('formatCountdownLine (#525)', () => {
  const NOW = 1_700_000_000_000

  it('renders minute granularity when more than a minute remains', () => {
    expect(formatCountdownLine(NOW + 10 * 60_000, NOW)).toBe(
      '⏱ Auto-deny in 10m — tap [Deny] to block now.',
    )
  })

  it('renders second granularity in the last minute', () => {
    expect(formatCountdownLine(NOW + 30_000, NOW)).toBe(
      '⏱ Auto-deny in 30s — tap [Deny] to block now.',
    )
  })

  it('rounds up sub-second deadlines so the user never sees "0s"', () => {
    expect(formatCountdownLine(NOW + 1, NOW)).toBe(
      '⏱ Auto-deny in 1s — tap [Deny] to block now.',
    )
  })

  it('switches to the timed-out template once the deadline passes', () => {
    expect(formatCountdownLine(NOW - 1, NOW)).toBe('⏱ Timed out — auto-deny.')
  })

  it('honours a custom default decision (e.g. allow)', () => {
    // Per-route override path — v0.1.0 always denies, but the helper
    // takes the decision so a future config change just flips the
    // string.
    expect(formatCountdownLine(NOW + 5 * 60_000, NOW, 'allow')).toContain(
      'Auto-allow in 5m',
    )
  })
})

// #525 — `renderApprovalNotification` bakes the first countdown line into the
// body so the initial send already shows a timer. Subsequent edits go through
// the CountdownTicker.
describe('renderApprovalNotification — countdown line (#525)', () => {
  it('appends a countdown tail when deadlineMs is set', () => {
    const future = Date.now() + 10 * 60_000
    const n = renderApprovalNotification(approvalEvent({ deadlineMs: future }))
    expect(n.body).toMatch(/⏱ Auto-deny in \d+m/)
    expect(n.body).toContain('tap [Deny] to block now')
  })

  it('omits the countdown tail when deadlineMs is absent (backward compat)', () => {
    const n = renderApprovalNotification(approvalEvent({ deadlineMs: undefined }))
    expect(n.body).not.toContain('⏱')
  })
})
