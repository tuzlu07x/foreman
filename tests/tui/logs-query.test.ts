import { describe, expect, it } from 'vitest'
import {
  buildFilterClause,
  DEFAULT_FILTERS,
  queryLogs,
  toFtsQuery,
  toJsonl,
  type LogFilters,
} from '../../src/tui/pages/logs-query.js'
import { createInMemoryDb } from '../../src/db/client.js'
import { requests } from '../../src/db/schema.js'

function makeFilters(partial: Partial<LogFilters> = {}): LogFilters {
  return { allowed: false, denied: false, ask: false, errored: false, ...partial }
}

describe('toFtsQuery', () => {
  it('converts plain word into prefix match', () => {
    expect(toFtsQuery('env')).toBe('env*')
  })
  it('quotes tokens with dots', () => {
    expect(toFtsQuery('.env')).toBe('".env"')
  })
  it('handles multiple tokens', () => {
    expect(toFtsQuery('read file')).toBe('read* file*')
  })
  it('drops special chars', () => {
    expect(toFtsQuery('foo!@#bar')).toBe('foo* bar*')
  })
})

describe('buildFilterClause', () => {
  it('returns null when all filters are on', () => {
    const params: (string | number)[] = []
    expect(buildFilterClause(DEFAULT_FILTERS, params)).toBeNull()
    expect(params).toEqual([])
  })
  it('returns 1=0 when nothing selected', () => {
    const params: (string | number)[] = []
    expect(buildFilterClause(makeFilters(), params)).toBe('1=0')
  })
  it('produces an OR clause for allowed only', () => {
    const params: (string | number)[] = []
    const sql = buildFilterClause(makeFilters({ allowed: true }), params)!
    expect(sql).toContain("requests.decision = 'allowed'")
    expect(params).toEqual(['auth-failure', 'route-error'])
  })
  it('produces a combined clause for allowed + denied', () => {
    const params: (string | number)[] = []
    const sql = buildFilterClause(
      makeFilters({ allowed: true, denied: true }),
      params,
    )!
    expect(sql).toContain("'allowed'")
    expect(sql).toContain("'denied'")
  })
})

describe('queryLogs', () => {
  it('returns rows ordered newest-first and respects limit', () => {
    const { sqlite, db } = createInMemoryDb()
    try {
      const now = Date.now()
      for (let i = 0; i < 5; i++) {
        db.insert(requests)
          .values({
            id: `r${i}`,
            sourceAgent: 'hermes',
            args: JSON.stringify({ path: `f${i}.ts` }),
            riskScore: 0,
            decision: 'allowed',
            decidedBy: 'auto',
            createdAt: now - i * 1000,
          })
          .run()
      }
      const result = queryLogs(sqlite, { limit: 3 })
      expect(result.rows.map((r) => r.id)).toEqual(['r0', 'r1', 'r2'])
    } finally {
      sqlite.close()
    }
  })

  it('filters to "errored" decided-by values', () => {
    const { sqlite, db } = createInMemoryDb()
    try {
      const now = Date.now()
      db.insert(requests)
        .values({
          id: 'r-auth',
          sourceAgent: 'hermes',
          args: '{}',
          riskScore: 0,
          decision: 'denied',
          decidedBy: 'auth-failure',
          createdAt: now,
        })
        .run()
      db.insert(requests)
        .values({
          id: 'r-ok',
          sourceAgent: 'hermes',
          args: '{}',
          riskScore: 0,
          decision: 'allowed',
          decidedBy: 'auto',
          createdAt: now,
        })
        .run()
      const result = queryLogs(sqlite, {
        filters: makeFilters({ errored: true }),
      })
      expect(result.rows.map((r) => r.id)).toEqual(['r-auth'])
    } finally {
      sqlite.close()
    }
  })

  it('FTS5 search narrows by content tokens', () => {
    const { sqlite, db } = createInMemoryDb()
    try {
      const now = Date.now()
      db.insert(requests)
        .values({
          id: 'r-env',
          sourceAgent: 'hermes',
          args: JSON.stringify({ path: '.env' }),
          riskScore: 0,
          decision: 'denied',
          decidedBy: 'user',
          createdAt: now,
        })
        .run()
      db.insert(requests)
        .values({
          id: 'r-auth',
          sourceAgent: 'hermes',
          args: JSON.stringify({ path: 'src/auth.ts' }),
          riskScore: 0,
          decision: 'allowed',
          decidedBy: 'auto',
          createdAt: now,
        })
        .run()
      const hits = queryLogs(sqlite, { search: 'env' })
      expect(hits.rows.map((r) => r.id)).toContain('r-env')
      expect(hits.rows.map((r) => r.id)).not.toContain('r-auth')
    } finally {
      sqlite.close()
    }
  })
})

describe('toJsonl', () => {
  it('serialises each row on its own line with trailing newline', () => {
    const out = toJsonl([
      {
        id: 'r1',
        sourceAgent: 'hermes',
        targetAgent: null,
        targetTool: null,
        args: '{}',
        riskScore: 0,
        riskReasons: null,
        riskFactors: null,
        riskBucket: null,
        llmVerification: null,
        securityReport: null,
        decision: 'allowed',
        decidedBy: 'auto',
        result: null,
        durationMs: null,
        createdAt: 0,
        decidedAt: null,
      },
    ])
    expect(out).toMatch(/^\{[^\n]+\}\n$/)
  })
})
