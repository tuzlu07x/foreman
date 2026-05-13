import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_RISK_RULES, RISK_THRESHOLD, RiskScorer } from '../../src/core/risk-scorer.js'
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

  it('exposes the documented threshold (50)', () => {
    expect(RISK_THRESHOLD).toBe(50)
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

  describe('secret_file_pattern (+50)', () => {
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
      const { score, reasons } = scorer.score({
        sourceAgent: 'hermes',
        targetTool: 'read_file',
        args: { path },
      })
      if (matches) {
        expect(reasons).toContain('secret_file_pattern')
        expect(score).toBeGreaterThanOrEqual(50)
      } else {
        expect(reasons).not.toContain('secret_file_pattern')
      }
    })

    it('does not fire when args has no path field', () => {
      const { reasons } = scorer.score({
        sourceAgent: 'hermes',
        targetTool: 'list_files',
        args: { directory: '.env' },
      })
      expect(reasons).not.toContain('secret_file_pattern')
    })
  })

  describe('outbound_network (+30)', () => {
    it.each(['fetch', 'http_get', 'https_post', 'wget', 'curl', 'request', 'send_email'])(
      'fires on tool=%s',
      (tool) => {
        const { reasons, score } = scorer.score({
          sourceAgent: 'hermes',
          targetTool: tool,
        })
        expect(reasons).toContain('outbound_network')
        expect(score).toBeGreaterThanOrEqual(30)
      },
    )

    it('does not fire on benign tools', () => {
      const { reasons } = scorer.score({
        sourceAgent: 'hermes',
        targetTool: 'read_file',
      })
      expect(reasons).not.toContain('outbound_network')
    })
  })

  describe('shell_exec (+40)', () => {
    it.each(['shell_exec', 'run_command', 'run_shell', 'bash', 'EXEC'])(
      'fires on tool=%s',
      (tool) => {
        const { reasons, score } = scorer.score({
          sourceAgent: 'hermes',
          targetTool: tool,
        })
        expect(reasons).toContain('shell_exec')
        expect(score).toBeGreaterThanOrEqual(40)
      },
    )

    it('does not fire on read_file', () => {
      const { reasons } = scorer.score({
        sourceAgent: 'hermes',
        targetTool: 'read_file',
      })
      expect(reasons).not.toContain('shell_exec')
    })
  })

  describe('first_agent_to_agent (+20)', () => {
    it('fires when no prior call to the target agent exists', () => {
      const { reasons, score } = scorer.score({
        sourceAgent: 'hermes',
        targetAgent: 'claude-code',
        targetTool: 'read_file',
        args: { path: 'src/auth.ts' },
      })
      expect(reasons).toContain('first_agent_to_agent')
      expect(score).toBeGreaterThanOrEqual(20)
    })

    it('does not fire after a recent call to the same target agent', () => {
      seedRequest(db, {
        sourceAgent: 'hermes',
        targetAgent: 'claude-code',
        targetTool: 'read_file',
        createdAt: Date.now() - 30_000,
      })
      const { reasons } = scorer.score({
        sourceAgent: 'hermes',
        targetAgent: 'claude-code',
        targetTool: 'read_file',
      })
      expect(reasons).not.toContain('first_agent_to_agent')
    })

    it('fires again if the prior call was more than an hour ago', () => {
      seedRequest(db, {
        sourceAgent: 'hermes',
        targetAgent: 'claude-code',
        createdAt: Date.now() - 2 * 60 * 60 * 1000,
      })
      const { reasons } = scorer.score({
        sourceAgent: 'hermes',
        targetAgent: 'claude-code',
        targetTool: 'read_file',
      })
      expect(reasons).toContain('first_agent_to_agent')
    })

    it('does not fire when there is no targetAgent', () => {
      const { reasons } = scorer.score({
        sourceAgent: 'hermes',
        targetTool: 'read_file',
      })
      expect(reasons).not.toContain('first_agent_to_agent')
    })
  })

  describe('previously_denied_pattern (+30)', () => {
    it('fires when the same source/tool was denied before', () => {
      seedRequest(db, {
        sourceAgent: 'hermes',
        targetTool: 'read_file',
        decision: 'denied',
      })
      const { reasons, score } = scorer.score({
        sourceAgent: 'hermes',
        targetTool: 'read_file',
      })
      expect(reasons).toContain('previously_denied_pattern')
      expect(score).toBeGreaterThanOrEqual(30)
    })

    it('does not fire when prior calls were allowed', () => {
      seedRequest(db, {
        sourceAgent: 'hermes',
        targetTool: 'read_file',
        decision: 'allowed',
      })
      const { reasons } = scorer.score({
        sourceAgent: 'hermes',
        targetTool: 'read_file',
      })
      expect(reasons).not.toContain('previously_denied_pattern')
    })
  })

  describe('composite scoring', () => {
    it('a .env read from a fresh agent-to-agent caller scores ≥ 50 (done-when)', () => {
      const { score, reasons } = scorer.score({
        sourceAgent: 'hermes',
        targetAgent: 'claude-code',
        targetTool: 'read_file',
        args: { path: '.env' },
      })
      expect(reasons).toEqual(
        expect.arrayContaining(['secret_file_pattern', 'first_agent_to_agent']),
      )
      expect(score).toBeGreaterThanOrEqual(RISK_THRESHOLD)
      expect(score).toBe(70)
    })

    it('benign read of a regular file scores 0 (after a prior allow primes the agent pair)', () => {
      seedRequest(db, {
        sourceAgent: 'claude-code',
        targetAgent: 'fs',
        createdAt: Date.now() - 10_000,
      })
      const { score, reasons } = scorer.score({
        sourceAgent: 'claude-code',
        targetAgent: 'fs',
        targetTool: 'read_file',
        args: { path: 'src/auth.ts' },
      })
      expect(score).toBe(0)
      expect(reasons).toEqual([])
    })

    it('accepts a custom rule set', () => {
      const custom = new RiskScorer(db, [
        {
          name: 'always_high',
          evaluate: () => ({ points: 99, reason: 'test rule' }),
        },
      ])
      const { score, reasons } = custom.score({
        sourceAgent: 'x',
        targetTool: 'y',
      })
      expect(score).toBe(99)
      expect(reasons).toEqual(['always_high'])
    })
  })
})
