import { describe, expect, it } from 'vitest'
import type { Request } from '../../src/db/schema.js'
import {
  DEFAULT_THRESHOLDS,
  describePattern,
  detectPatterns,
  type DetectedPattern,
} from '../../src/core/pattern-detection.js'

// =============================================================================
// Tests for #304 — pattern detection v1 (pure detector)
// =============================================================================
//
// Pins the four pattern shapes + threshold cliffs + message rendering.
// The scheduler/dispatch glue is tested separately in
// pattern-detection-service.test.ts.

function row(overrides: Partial<Request>): Request {
  return {
    id: 'r-' + Math.random().toString(36).slice(2, 10),
    sourceAgent: 'hermes',
    targetAgent: null,
    targetTool: 'read_file',
    args: JSON.stringify({ path: '.env' }),
    riskScore: 0,
    riskReasons: null,
    riskFactors: null,
    riskBucket: null,
    llmVerification: null,
    securityReport: null,
    decision: 'denied',
    decidedBy: 'user',
    result: null,
    durationMs: 1,
    createdAt: 0,
    decidedAt: 1,
    parentRequestId: null,
    sessionId: null,
    ...overrides,
  }
}

const NOW = 1_730_000_000_000
const HOUR = 60 * 60 * 1000

function repeats(count: number, base: Partial<Request>): Request[] {
  return Array.from({ length: count }, (_, i) =>
    row({ ...base, createdAt: NOW - 1000 * i }),
  )
}

describe('detectPatterns — repeated denial', () => {
  it('fires when same source+target+tool denied >= threshold', () => {
    const rows = repeats(3, { decision: 'denied' })
    const patterns = detectPatterns(rows, NOW)
    const denied = patterns.filter((p) => p.kind === 'repeated_denial')
    expect(denied).toHaveLength(1)
    expect(denied[0]!.count).toBe(3)
    expect(denied[0]!.sourceAgent).toBe('hermes')
  })

  it('does NOT fire below the threshold', () => {
    const rows = repeats(2, { decision: 'denied' })
    expect(detectPatterns(rows, NOW)).toEqual([])
  })

  it('drops rows older than the window', () => {
    const old = repeats(2, { decision: 'denied' }).map((r) => ({
      ...r,
      createdAt: NOW - 2 * HOUR, // outside default 1h window
    }))
    const fresh = repeats(2, { decision: 'denied' })
    const patterns = detectPatterns([...old, ...fresh], NOW)
    expect(patterns).toEqual([]) // 2 fresh < threshold of 3
  })

  it('keys by source+target+tool — different tools count separately', () => {
    const aRows = repeats(3, { decision: 'denied', targetTool: 'read_file' })
    const bRows = repeats(3, { decision: 'denied', targetTool: 'write_file' })
    const patterns = detectPatterns([...aRows, ...bRows], NOW).filter(
      (p) => p.kind === 'repeated_denial',
    )
    expect(patterns).toHaveLength(2)
  })
})

describe('detectPatterns — repeated allow', () => {
  it('fires at the higher repeatedAllowMin (5 by default)', () => {
    const rows = repeats(5, { decision: 'allowed' })
    const patterns = detectPatterns(rows, NOW)
    const allowed = patterns.filter((p) => p.kind === 'repeated_allow')
    expect(allowed).toHaveLength(1)
    expect(allowed[0]!.count).toBe(5)
  })

  it('does NOT fire at 4 (below the higher allow threshold)', () => {
    const rows = repeats(4, { decision: 'allowed' })
    const allowed = detectPatterns(rows, NOW).filter(
      (p) => p.kind === 'repeated_allow',
    )
    expect(allowed).toEqual([])
  })
})

describe('detectPatterns — burst', () => {
  it('fires when an agent makes >= burstMin requests in burstWindowMs', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ createdAt: NOW - i * 5000, decision: 'allowed' }),
    )
    const patterns = detectPatterns(rows, NOW)
    const burst = patterns.filter((p) => p.kind === 'burst')
    expect(burst).toHaveLength(1)
    expect(burst[0]!.count).toBe(10)
  })

  it('does NOT fire when only 9 in window', () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      row({ createdAt: NOW - i * 5000, decision: 'allowed' }),
    )
    const burst = detectPatterns(rows, NOW).filter((p) => p.kind === 'burst')
    expect(burst).toEqual([])
  })

  it('per-agent grouping — two agents at 5 each = no burst', () => {
    const a = Array.from({ length: 5 }, (_, i) =>
      row({ createdAt: NOW - i * 5000, decision: 'allowed', sourceAgent: 'a' }),
    )
    const b = Array.from({ length: 5 }, (_, i) =>
      row({ createdAt: NOW - i * 5000, decision: 'allowed', sourceAgent: 'b' }),
    )
    const burst = detectPatterns([...a, ...b], NOW).filter(
      (p) => p.kind === 'burst',
    )
    expect(burst).toEqual([])
  })
})

describe('detectPatterns — off_responsibility_cluster', () => {
  it('fires when responsibility_violation factor hits N+ times', () => {
    const rfs = JSON.stringify([
      { rule: 'responsibility_violation', category: 'structural', points: 60 },
    ])
    const rows = repeats(3, { decision: 'denied', riskFactors: rfs })
    const cluster = detectPatterns(rows, NOW).filter(
      (p) => p.kind === 'off_responsibility_cluster',
    )
    expect(cluster).toHaveLength(1)
    expect(cluster[0]!.count).toBe(3)
  })

  it('also fires on responsibility_violation_delegation / _service variants', () => {
    const rfs = JSON.stringify([
      {
        rule: 'responsibility_violation_delegation',
        category: 'structural',
        points: 50,
      },
    ])
    const rows = repeats(3, { decision: 'denied', riskFactors: rfs })
    const cluster = detectPatterns(rows, NOW).filter(
      (p) => p.kind === 'off_responsibility_cluster',
    )
    expect(cluster).toHaveLength(1)
  })

  it('does NOT fire when the factor is something else (e.g. secret_pattern only)', () => {
    const rfs = JSON.stringify([
      { rule: 'secret_pattern', category: 'secret', points: 50 },
    ])
    const rows = repeats(5, { decision: 'denied', riskFactors: rfs })
    const cluster = detectPatterns(rows, NOW).filter(
      (p) => p.kind === 'off_responsibility_cluster',
    )
    expect(cluster).toEqual([])
  })

  it('survives malformed riskFactors JSON', () => {
    const rows = repeats(3, { decision: 'denied', riskFactors: 'not json' })
    expect(() => detectPatterns(rows, NOW)).not.toThrow()
  })
})

describe('detectPatterns — composite + threshold overrides', () => {
  it('returns multiple distinct patterns when several thresholds trip', () => {
    const denied = repeats(3, { decision: 'denied' })
    const rfs = JSON.stringify([
      { rule: 'responsibility_violation', category: 'structural', points: 60 },
    ])
    const respHits = repeats(3, {
      decision: 'denied',
      sourceAgent: 'other',
      riskFactors: rfs,
    })
    const patterns = detectPatterns([...denied, ...respHits], NOW)
    const kinds = patterns.map((p) => p.kind).sort()
    expect(kinds).toContain('repeated_denial')
    expect(kinds).toContain('off_responsibility_cluster')
  })

  it('honours custom thresholds (lower numbers fire earlier)', () => {
    const rows = repeats(2, { decision: 'denied' })
    const patterns = detectPatterns(rows, NOW, {
      ...DEFAULT_THRESHOLDS,
      repeatedDenialMin: 2,
    })
    expect(patterns.some((p) => p.kind === 'repeated_denial')).toBe(true)
  })

  it('returns empty array on empty input (no rows)', () => {
    expect(detectPatterns([], NOW)).toEqual([])
  })
})

describe('describePattern', () => {
  function pattern(overrides: Partial<DetectedPattern>): DetectedPattern {
    return {
      kind: 'repeated_denial',
      key: 'k',
      sourceAgent: 'hermes',
      count: 3,
      windowMs: HOUR,
      detail: {
        kind: 'repeated_denial',
        targetAgent: null,
        targetTool: 'read_file',
      },
      ...overrides,
    } as DetectedPattern
  }

  it('repeated_denial body suggests the deny policy CLI', () => {
    const { title, body } = describePattern(pattern({}))
    expect(title).toMatch(/Repeated denial/)
    expect(body).toContain('foreman policy add')
    expect(body).toContain('--effect deny')
    expect(body).toContain('hermes')
  })

  it('repeated_allow body suggests the allow policy CLI', () => {
    const { body } = describePattern(
      pattern({
        kind: 'repeated_allow',
        count: 5,
        detail: {
          kind: 'repeated_allow',
          targetAgent: null,
          targetTool: 'read_file',
        },
      }),
    )
    expect(body).toContain('--effect allow')
  })

  it('burst body mentions per-minute rate', () => {
    const { title, body } = describePattern(
      pattern({
        kind: 'burst',
        count: 12,
        windowMs: 60_000,
        detail: { kind: 'burst', perMinute: 12 },
      }),
    )
    expect(title).toMatch(/Burst/)
    expect(body).toMatch(/12.*\/min/)
  })

  it('off_responsibility_cluster body points to policy.yaml', () => {
    const { title, body } = describePattern(
      pattern({
        kind: 'off_responsibility_cluster',
        detail: {
          kind: 'off_responsibility_cluster',
          ruleHits: 5,
        },
      }),
    )
    expect(title).toMatch(/Off-responsibility/)
    expect(body).toMatch(/responsibility_policies/)
  })
})
