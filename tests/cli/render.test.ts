import { describe, expect, it } from 'vitest'
import type { RegisteredAgent } from '../../src/core/registry.js'
import type { policies, Request } from '../../src/db/schema.js'
import {
  renderAgentJson,
  renderAgentLine,
  renderPolicyJson,
  renderPolicyLine,
  renderRequestDetail,
  renderRequestJson,
  renderRequestLine,
} from '../../src/cli/render.js'

type PolicyRow = typeof policies.$inferSelect

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

const sampleRequest: Request = {
  id: 'req-1',
  sourceAgent: 'hermes',
  targetAgent: 'claude-code',
  targetTool: 'read_file',
  args: JSON.stringify({ path: 'src/auth.ts' }),
  riskScore: 12,
  riskReasons: JSON.stringify(['secret_file_pattern']),
  riskFactors: null,
  riskBucket: null,
  llmVerification: null,
  decision: 'allowed',
  decidedBy: 'policy:7',
  result: JSON.stringify({ size: 1234 }),
  durationMs: 18,
  createdAt: new Date('2026-05-13T09:14:23').getTime(),
  decidedAt: new Date('2026-05-13T09:14:23.018').getTime(),
}

const sampleAgent: RegisteredAgent = {
  id: 'hermes',
  displayName: 'Hermes Personal Assistant',
  transport: 'stdio',
  endpoint: null,
  status: 'active',
  registeredAt: Date.now() - 60_000,
  lastSeenAt: Date.now() - 5_000,
  metadata: null,
  llmProvider: null,
  responsibilityNote: null,
}

const samplePolicy: PolicyRow = {
  id: 7,
  sourceAgent: 'hermes',
  target: 'claude-code:read_file',
  effect: 'allow',
  conditions: null,
  createdAt: Date.now() - 60_000,
  createdBy: 'yaml',
  enabled: 1,
}

describe('renderRequestLine', () => {
  it('formats one row as a single human line', () => {
    const out = stripAnsi(renderRequestLine(sampleRequest))
    expect(out).toContain('hermes → claude-code')
    expect(out).toContain('read_file')
    expect(out).toContain('✓')
    expect(out).toContain('allowed · policy:7 · 18ms')
  })

  it('renders ✗ for denied and · decidedBy', () => {
    const out = stripAnsi(
      renderRequestLine({
        ...sampleRequest,
        decision: 'denied',
        decidedBy: 'user',
      }),
    )
    expect(out).toContain('✗')
    expect(out).toContain('denied · user')
  })

  it('handles missing target / tool / duration gracefully', () => {
    const out = stripAnsi(
      renderRequestLine({
        ...sampleRequest,
        targetAgent: null,
        targetTool: null,
        durationMs: null,
      }),
    )
    expect(out).toContain('hermes')
    expect(out).toContain('(no tool)')
    expect(out).not.toMatch(/null/)
  })
})

describe('renderRequestJson', () => {
  it('parses args / riskReasons / result back into objects', () => {
    const out = renderRequestJson(sampleRequest) as {
      args: { path: string }
      riskReasons: string[]
      result: { size: number }
    }
    expect(out.args.path).toBe('src/auth.ts')
    expect(out.riskReasons).toEqual(['secret_file_pattern'])
    expect(out.result.size).toBe(1234)
  })

  it('handles null riskReasons and result', () => {
    const out = renderRequestJson({
      ...sampleRequest,
      riskReasons: null,
      result: null,
    }) as { riskReasons: unknown[]; result: unknown }
    expect(out.riskReasons).toEqual([])
    expect(out.result).toBeNull()
  })
})

describe('renderRequestDetail', () => {
  it('includes id, created, source, decision and a pretty args block', () => {
    const out = stripAnsi(renderRequestDetail(sampleRequest))
    expect(out).toContain('id            req-1')
    expect(out).toContain('source        hermes')
    expect(out).toContain('target        claude-code')
    expect(out).toContain('tool          read_file')
    expect(out).toContain('decision      allowed (policy:7)')
    expect(out).toContain('risk          12/100')
    expect(out).toContain('reasons       secret_file_pattern')
    expect(out).toContain('"path": "src/auth.ts"')
    expect(out).toContain('"size": 1234')
  })
})

describe('renderAgentLine', () => {
  it('shows ● for active and includes id + displayName + status', () => {
    const out = stripAnsi(renderAgentLine(sampleAgent))
    expect(out).toContain('●')
    expect(out).toContain('hermes')
    expect(out).toContain('Hermes Personal Assistant')
    expect(out).toContain('status=active')
  })

  it('shows ● (red) for blocked, ○ for inactive', () => {
    expect(stripAnsi(renderAgentLine({ ...sampleAgent, status: 'blocked' }))).toContain('●')
    expect(stripAnsi(renderAgentLine({ ...sampleAgent, status: 'inactive' }))).toContain('○')
  })

  it('renders "never" when lastSeenAt is null', () => {
    const out = stripAnsi(
      renderAgentLine({ ...sampleAgent, lastSeenAt: null }),
    )
    expect(out).toContain('last=never')
  })
})

describe('renderAgentJson', () => {
  it('exposes all the fields callers might pipe', () => {
    const out = renderAgentJson(sampleAgent) as { id: string; status: string }
    expect(out.id).toBe('hermes')
    expect(out.status).toBe('active')
  })
})

describe('renderPolicyLine', () => {
  it('shows id, source → target, effect tag, createdBy', () => {
    const out = stripAnsi(renderPolicyLine(samplePolicy))
    expect(out).toContain('#7')
    expect(out).toContain('hermes')
    expect(out).toContain('claude-code:read_file')
    expect(out).toContain('ALLOW')
    expect(out).toContain('(yaml)')
  })

  it('appends DISABLED for enabled=0', () => {
    const out = stripAnsi(renderPolicyLine({ ...samplePolicy, enabled: 0 }))
    expect(out).toContain('DISABLED')
  })

  it.each(['allow', 'deny', 'ask'] as const)(
    'renders %s effect tag',
    (effect) => {
      const out = stripAnsi(renderPolicyLine({ ...samplePolicy, effect }))
      expect(out.toUpperCase()).toContain(effect.toUpperCase())
    },
  )
})

describe('renderPolicyJson', () => {
  it('returns enabled as boolean, parses conditions JSON when present', () => {
    const out = renderPolicyJson({
      ...samplePolicy,
      conditions: JSON.stringify({ pathNotMatch: '\\.env$' }),
    }) as {
      enabled: boolean
      conditions: { pathNotMatch: string }
    }
    expect(out.enabled).toBe(true)
    expect(out.conditions.pathNotMatch).toBe('\\.env$')
  })
})
