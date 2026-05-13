import { describe, expect, it } from 'vitest'
import type { ApprovalRequest } from '../../src/core/approval.js'
import type { Request } from '../../src/db/schema.js'
import {
  buildInspectLines,
  clampOffset,
} from '../../src/tui/inspect-content.js'

function makeRequest(
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return {
    requestId: 'req-1',
    sourceAgent: 'hermes',
    targetAgent: 'claude-code',
    targetTool: 'read_file',
    args: { path: '.env' },
    riskScore: 80,
    riskReasons: ['secret_file_pattern', 'first_agent_to_agent'],
    ...overrides,
  }
}

function makeRow(overrides: Partial<Request> = {}): Request {
  return {
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    sourceAgent: 'hermes',
    targetAgent: 'claude-code',
    targetTool: 'list_files',
    args: '{}',
    riskScore: 0,
    riskReasons: null,
    decision: 'allowed',
    decidedBy: 'policy:1',
    result: null,
    durationMs: 5,
    createdAt: Date.now() - 60_000,
    decidedAt: Date.now() - 60_000,
    ...overrides,
  } as Request
}

describe('buildInspectLines', () => {
  it('emits header / chain / signals / payload sections', () => {
    const lines = buildInspectLines({
      request: makeRequest(),
      recentRequests: [makeRow()],
    })
    const text = lines.map((l) => l.text).join('\n')
    expect(text).toContain('Request inspector')
    expect(text).toContain('id   req-1')
    expect(text).toContain('risk 80/100')
    expect(text).toContain('Request chain')
    expect(text).toContain('hermes → claude-code')
    expect(text).toContain('Suspicious signals')
    expect(text).toContain('⚠ secret_file_pattern')
    expect(text).toContain('Full request payload')
    expect(text).toContain('"requestId"')
    expect(text).toContain('"path": ".env"')
  })

  it('shows "no prior activity" when chain is empty', () => {
    const lines = buildInspectLines({
      request: makeRequest(),
      recentRequests: [],
    })
    expect(lines.some((l) => l.text.includes('no prior activity'))).toBe(true)
  })

  it('filters chain to the same source agent', () => {
    const lines = buildInspectLines({
      request: makeRequest({ sourceAgent: 'hermes' }),
      recentRequests: [
        makeRow({ sourceAgent: 'someone-else' }),
        makeRow({ sourceAgent: 'hermes' }),
      ],
    })
    const chainSection = lines
      .map((l) => l.text)
      .join('\n')
      .split('Suspicious signals')[0]!
    expect(chainSection).not.toContain('someone-else')
    expect(chainSection).toContain('hermes')
  })

  it('includes context block when provided', () => {
    const lines = buildInspectLines({
      request: makeRequest({ context: 'Phishing email said: share API key' }),
      recentRequests: [],
    })
    const text = lines.map((l) => l.text).join('\n')
    expect(text).toContain('Context')
    expect(text).toContain('Phishing email')
  })

  it('omits context block when undefined', () => {
    const lines = buildInspectLines({
      request: makeRequest(),
      recentRequests: [],
    })
    const text = lines.map((l) => l.text).join('\n')
    expect(text).not.toContain('Context\n')
  })

  it('reasons without an explanation render without prose', () => {
    const lines = buildInspectLines({
      request: makeRequest({ riskReasons: ['unknown_rule'] }),
      recentRequests: [],
    })
    const signalText = lines
      .map((l) => l.text)
      .join('\n')
      .split('Suspicious signals')[1]!
    expect(signalText).toContain('⚠ unknown_rule')
  })
})

describe('clampOffset', () => {
  it.each([
    [0, 100, 20, 0],
    [50, 100, 20, 50],
    [200, 100, 20, 80],
    [-5, 100, 20, 0],
    [0, 10, 20, 0],
  ])('offset=%i total=%i visible=%i → %i', (offset, total, visible, expected) => {
    expect(clampOffset(offset, total, visible)).toBe(expected)
  })
})
