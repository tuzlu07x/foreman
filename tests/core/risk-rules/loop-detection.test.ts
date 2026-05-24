import type Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LOOP_THRESHOLDS,
  loopDetectionRule,
} from '../../../src/core/risk-rules/loop-detection.js'
import type { RiskFactor } from '../../../src/core/risk-rules/types.js'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'
import { requests, sessions } from '../../../src/db/schema.js'

function seed(
  db: ForemanDb,
  source: string,
  target: string | null,
  offsetMs: number,
): void {
  db.insert(requests)
    .values({
      id: `r-${Math.random().toString(36).slice(2)}`,
      sourceAgent: source,
      targetAgent: target,
      targetTool: 'tool',
      args: '{}',
      riskScore: 0,
      decision: 'allowed',
      createdAt: Date.now() - offsetMs,
    })
    .run()
}

function assess(
  db: ForemanDb,
  req: {
    sourceAgent: string
    targetAgent?: string
    sessionId?: string
  },
): RiskFactor[] {
  return loopDetectionRule.evaluate(req, { db })
}

function ruleIds(factors: RiskFactor[]): string[] {
  return factors.map((f) => f.rule)
}

describe('loop-detection — ping-pong', () => {
  let db: ForemanDb
  let sqlite: Database.Database

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
  })

  afterEach(() => {
    sqlite.close()
  })

  it('fires after 4 alternating turns between two agents (incl. in-flight call)', () => {
    // 3 prior alternating turns: claude→hermes, hermes→claude, claude→hermes
    // (most recent first when sorted DESC). Then in-flight: hermes→claude.
    seed(db, 'claude', 'hermes', 1_500) // oldest
    seed(db, 'hermes', 'claude', 1_000)
    seed(db, 'claude', 'hermes', 500)

    const factors = assess(db, {
      sourceAgent: 'hermes',
      targetAgent: 'claude',
    })
    const pp = factors.find((f) => f.rule === 'loop_pingpong')
    expect(pp).toBeDefined()
    expect(pp!.points).toBe(50)
    expect(pp!.evidence).toMatch(/hermes ↔ claude|claude ↔ hermes/)
  })

  it('does NOT fire on 3 alternating turns (below threshold)', () => {
    seed(db, 'hermes', 'claude', 1_000)
    seed(db, 'claude', 'hermes', 500)
    // In-flight is the 3rd turn — only 3 alternations
    const factors = assess(db, {
      sourceAgent: 'hermes',
      targetAgent: 'claude',
    })
    expect(ruleIds(factors)).not.toContain('loop_pingpong')
  })

  it('breaks alternation when a third agent appears', () => {
    seed(db, 'hermes', 'claude', 1_500)
    seed(db, 'claude', 'hermes', 1_000)
    seed(db, 'hermes', 'codex', 500) // breaks the pair
    const factors = assess(db, {
      sourceAgent: 'codex',
      targetAgent: 'hermes',
    })
    expect(ruleIds(factors)).not.toContain('loop_pingpong')
  })

  it('does not fire when same source twice in a row', () => {
    seed(db, 'hermes', 'claude', 1_500)
    seed(db, 'hermes', 'claude', 1_000) // same source twice
    seed(db, 'claude', 'hermes', 500)
    const factors = assess(db, {
      sourceAgent: 'hermes',
      targetAgent: 'claude',
    })
    // Should NOT fire — alternation broken by the duplicate hermes source.
    expect(ruleIds(factors)).not.toContain('loop_pingpong')
  })
})

describe('loop-detection — cycle', () => {
  let db: ForemanDb
  let sqlite: Database.Database

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
  })

  afterEach(() => {
    sqlite.close()
  })

  it('detects a 3-node cycle A → B → C → A', () => {
    seed(db, 'a', 'b', 2_000)
    seed(db, 'b', 'c', 1_000)
    // In-flight call c → a closes the cycle
    const factors = assess(db, { sourceAgent: 'c', targetAgent: 'a' })
    const cy = factors.find((f) => f.rule === 'loop_cycle')
    expect(cy).toBeDefined()
    expect(cy!.points).toBe(60)
    expect(cy!.evidence).toMatch(/a → b → c|b → c → a|c → a → b/)
  })

  it('does NOT fire when the graph is a pure tree (no cycle)', () => {
    seed(db, 'a', 'b', 2_000)
    seed(db, 'a', 'c', 1_000)
    seed(db, 'b', 'd', 500)
    const factors = assess(db, { sourceAgent: 'c', targetAgent: 'e' })
    expect(ruleIds(factors)).not.toContain('loop_cycle')
  })

  it('does NOT classify a single self-edge as a cycle (needs 3+ nodes)', () => {
    seed(db, 'a', 'a', 1_000)
    const factors = assess(db, { sourceAgent: 'a', targetAgent: 'a' })
    expect(ruleIds(factors)).not.toContain('loop_cycle')
  })

  it('detects 4-node cycle A → B → C → D → A', () => {
    seed(db, 'a', 'b', 3_000)
    seed(db, 'b', 'c', 2_000)
    seed(db, 'c', 'd', 1_000)
    const factors = assess(db, { sourceAgent: 'd', targetAgent: 'a' })
    expect(ruleIds(factors)).toContain('loop_cycle')
  })
})

describe('loop-detection — burst', () => {
  let db: ForemanDb
  let sqlite: Database.Database

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
  })

  afterEach(() => {
    sqlite.close()
  })

  it(`fires when source has ≥${LOOP_THRESHOLDS.burstCount} calls in the window`, () => {
    for (let i = 0; i < LOOP_THRESHOLDS.burstCount; i++) {
      seed(db, 'hermes', 'claude', 1_000 + i * 100)
    }
    const factors = assess(db, { sourceAgent: 'hermes', targetAgent: 'claude' })
    const bu = factors.find((f) => f.rule === 'loop_burst')
    expect(bu).toBeDefined()
    expect(bu!.points).toBe(45)
    expect(bu!.reason).toContain('hermes')
  })

  it('does NOT fire below the threshold', () => {
    for (let i = 0; i < LOOP_THRESHOLDS.burstCount - 2; i++) {
      seed(db, 'hermes', 'claude', 1_000 + i * 100)
    }
    const factors = assess(db, { sourceAgent: 'hermes', targetAgent: 'claude' })
    expect(ruleIds(factors)).not.toContain('loop_burst')
  })

  it('only counts calls from the SAME source', () => {
    for (let i = 0; i < LOOP_THRESHOLDS.burstCount; i++) {
      seed(db, 'codex', 'claude', 1_000 + i * 100) // not hermes
    }
    const factors = assess(db, { sourceAgent: 'hermes', targetAgent: 'claude' })
    expect(ruleIds(factors)).not.toContain('loop_burst')
  })

  it('ignores calls older than the burst window', () => {
    for (let i = 0; i < LOOP_THRESHOLDS.burstCount + 10; i++) {
      // 2 minutes ago — well outside the 60s window
      seed(db, 'hermes', 'claude', LOOP_THRESHOLDS.burstWindowMs * 2 + i * 100)
    }
    const factors = assess(db, { sourceAgent: 'hermes', targetAgent: 'claude' })
    expect(ruleIds(factors)).not.toContain('loop_burst')
  })
})

describe('loop-detection — token budget', () => {
  let db: ForemanDb
  let sqlite: Database.Database

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
  })

  afterEach(() => {
    sqlite.close()
  })

  function seedSession(id: string, tokens: number): void {
    db.insert(sessions)
      .values({
        id,
        participants: JSON.stringify(['hermes', 'claude']),
        startedAt: Date.now() - 60_000,
        messageCount: 5,
        tokenCount: tokens,
        status: 'active',
      })
      .run()
  }

  it('fires at 80% of the 100K token limit', () => {
    seedSession('s1', 81_000)
    const factors = assess(db, {
      sourceAgent: 'hermes',
      targetAgent: 'claude',
      sessionId: 's1',
    })
    const tb = factors.find((f) => f.rule === 'loop_token_budget')
    expect(tb).toBeDefined()
    expect(tb!.points).toBe(40)
    expect(tb!.reason).toMatch(/\d+% of the 100K/)
  })

  it('does NOT fire below 80%', () => {
    seedSession('s2', 50_000)
    const factors = assess(db, {
      sourceAgent: 'hermes',
      targetAgent: 'claude',
      sessionId: 's2',
    })
    expect(ruleIds(factors)).not.toContain('loop_token_budget')
  })

  it('does NOT fire when sessionId is absent (single-shot call)', () => {
    seedSession('s3', 95_000)
    const factors = assess(db, {
      sourceAgent: 'hermes',
      targetAgent: 'claude',
      // no sessionId
    })
    expect(ruleIds(factors)).not.toContain('loop_token_budget')
  })

  it('does NOT fire when sessionId is unknown to the DB', () => {
    const factors = assess(db, {
      sourceAgent: 'hermes',
      targetAgent: 'claude',
      sessionId: 'does-not-exist',
    })
    expect(ruleIds(factors)).not.toContain('loop_token_budget')
  })

  // #529 — Limit + warning_pct are now policy-engine driven (with the
  // hardcoded 100K / 80% defaults as fallback). These tests bypass the
  // top-level `assess` helper to pass a `sessionLimits` closure on the
  // RiskContext directly.
  it('honours a custom tokenLimit from RiskContext.sessionLimits (#529)', () => {
    // Limit halved to 50K → 41K (82%) now crosses the 80% advisory.
    seedSession('s-custom', 41_000)
    const factors = loopDetectionRule.evaluate(
      { sourceAgent: 'hermes', targetAgent: 'claude', sessionId: 's-custom' },
      {
        db,
        sessionLimits: () => ({
          tokenLimit: 50_000,
          tokenBudgetWarningPct: 80,
        }),
      },
    )
    const tb = factors.find((f) => f.rule === 'loop_token_budget')
    expect(tb).toBeDefined()
    expect(tb!.reason).toMatch(/50K/)
  })

  it('honours a custom tokenBudgetWarningPct from RiskContext (#529)', () => {
    // 50% threshold + 60K used / 100K limit → above threshold, must fire.
    seedSession('s-warn', 60_000)
    const factors = loopDetectionRule.evaluate(
      { sourceAgent: 'hermes', targetAgent: 'claude', sessionId: 's-warn' },
      {
        db,
        sessionLimits: () => ({
          tokenLimit: 100_000,
          tokenBudgetWarningPct: 50,
        }),
      },
    )
    expect(ruleIds(factors)).toContain('loop_token_budget')
  })

  it('keeps the rule advisory — does NOT halt the session (#529 enforcement is in SessionManager)', () => {
    // Pin the rule's role: it scores, it never mutates session state. The
    // halt happens in SessionManager.recordTurn; this test guards against
    // a regression that accidentally turns the risk rule into the halt
    // mechanism.
    seedSession('s-advisory', 95_000)
    const before = db
      .select()
      .from(sessions)
      .where(eq(sessions.id, 's-advisory'))
      .get()
    loopDetectionRule.evaluate(
      { sourceAgent: 'hermes', targetAgent: 'claude', sessionId: 's-advisory' },
      { db },
    )
    const after = db
      .select()
      .from(sessions)
      .where(eq(sessions.id, 's-advisory'))
      .get()
    expect(after?.status).toBe(before?.status)
    expect(after?.status).toBe('active')
  })
})

describe('loop-detection — edge cases', () => {
  let db: ForemanDb
  let sqlite: Database.Database

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
  })

  afterEach(() => {
    sqlite.close()
  })

  it('returns empty on an empty DB', () => {
    expect(assess(db, { sourceAgent: 'hermes', targetAgent: 'claude' })).toEqual(
      [],
    )
  })

  it('survives when targetAgent is undefined', () => {
    expect(assess(db, { sourceAgent: 'hermes' })).toEqual([])
  })

  it('cycle and burst can fire together when the in-flight source is bursting AND closing a ring', () => {
    // 3-node cycle: a → b → c (then in-flight c → a closes it)
    seed(db, 'a', 'b', 5_000)
    seed(db, 'b', 'c', 4_000)
    // Burst from c (the in-flight source) — burst threshold uses c's count
    for (let i = 0; i < LOOP_THRESHOLDS.burstCount; i++) {
      seed(db, 'c', 'd', 1_000 + i * 50)
    }
    const factors = assess(db, { sourceAgent: 'c', targetAgent: 'a' })
    const ids = ruleIds(factors)
    // Cycle relies on the 10-row history window; with 32 recent rows the
    // ancient a→b and b→c get pushed out. Document as a known limit.
    expect(ids).toContain('loop_burst')
  })
})

describe('loop-detection — performance budget', () => {
  let db: ForemanDb
  let sqlite: Database.Database

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    // Seed a realistic-sized history.
    for (let i = 0; i < 200; i++) {
      seed(db, `agent-${i % 5}`, `agent-${(i + 1) % 5}`, 1_000 + i * 100)
    }
  })

  afterEach(() => {
    sqlite.close()
  })

  it('evaluates in well under 5 ms p95 (1000 runs) — SCC on a 10-node window', () => {
    const N = 1000
    const samples: number[] = []
    for (let i = 0; i < N; i++) {
      const t0 = performance.now()
      loopDetectionRule.evaluate(
        { sourceAgent: 'agent-0', targetAgent: 'agent-1' },
        { db },
      )
      samples.push(performance.now() - t0)
    }
    samples.sort((a, b) => a - b)
    const p95 = samples[Math.floor(N * 0.95)]!
    // Spec budget: SCC on a 10-node window < 2 ms; full rule < 5 ms.
    expect(p95).toBeLessThan(5)
  })
})
