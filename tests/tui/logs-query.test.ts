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
  it('converts plain word into a quoted prefix match', () => {
    expect(toFtsQuery('env')).toBe('"env"*')
  })
  it('quotes tokens with dots', () => {
    expect(toFtsQuery('.env')).toBe('".env"*')
  })
  it('handles multiple tokens', () => {
    expect(toFtsQuery('read file')).toBe('"read"* "file"*')
  })
  it('quotes hyphens and operators instead of parsing them', () => {
    expect(toFtsQuery('qa-b')).toBe('"qa-b"*')
    expect(toFtsQuery('rm -rf')).toBe('"rm"* "-rf"*')
    expect(toFtsQuery('a AND')).toBe('"a"* "AND"*')
  })
  it('doubles inner quotes', () => {
    expect(toFtsQuery('say "hi"')).toBe('"say"* """hi"""*')
  })
  it('drops words with no letter or digit', () => {
    expect(toFtsQuery('*** -')).toBeNull()
    expect(toFtsQuery('env ***')).toBe('"env"*')
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

// QA #657 H3 — a hyphen in the Logs search crashed the whole TUI (and
// `foreman log search claude-code` exited 7 with a raw SqliteError).
describe('queryLogs — search text is never FTS5 syntax', () => {
  function seeded() {
    const { sqlite, db } = createInMemoryDb()
    const now = Date.now()
    db.insert(requests)
      .values({
        id: 'r-cc',
        sourceAgent: 'claude-code',
        targetTool: 'shell_exec',
        args: JSON.stringify({ command: 'rm -rf /tmp/x' }),
        riskScore: 0,
        decision: 'denied',
        decidedBy: 'user',
        createdAt: now,
      })
      .run()
    db.insert(requests)
      .values({
        id: 'r-qa',
        sourceAgent: 'qa-bot',
        targetTool: 'read_file',
        args: JSON.stringify({ path: 'README.md' }),
        riskScore: 0,
        decision: 'allowed',
        decidedBy: 'auto',
        createdAt: now - 1000,
      })
      .run()
    return sqlite
  }

  it.each(['qa-', 'qa-b', 'claude-code', 'generic-mcp', 'rm -rf', 'foo-bar', '-x', '***', 'a AND', 'NOT', '"', 'x:y', '(', 'NEAR(a b)'])(
    'does not throw for %j',
    (text) => {
      const sqlite = seeded()
      try {
        const result = queryLogs(sqlite, { search: text })
        expect(result.error).toBeUndefined()
      } finally {
        sqlite.close()
      }
    },
  )

  it('finds agent ids with hyphens as typed', () => {
    const sqlite = seeded()
    try {
      expect(queryLogs(sqlite, { search: 'qa-b' }).rows.map((r) => r.id)).toEqual(['r-qa'])
      expect(queryLogs(sqlite, { search: 'claude-code' }).rows.map((r) => r.id)).toEqual(['r-cc'])
      expect(queryLogs(sqlite, { search: 'rm -rf' }).rows.map((r) => r.id)).toEqual(['r-cc'])
    } finally {
      sqlite.close()
    }
  })

  it('reports a query the database rejects instead of throwing', () => {
    const sqlite = seeded()
    try {
      sqlite.exec('DROP TABLE requests_fts')
      const result = queryLogs(sqlite, { search: 'env' })
      expect(result.rows).toEqual([])
      expect(result.error).toMatch(/^invalid search: /)
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
        parentRequestId: null,
        sessionId: null,
      },
    ])
    expect(out).toMatch(/^\{[^\n]+\}\n$/)
  })
})

// #301 — sessionId filter narrows rows to a single agent-to-agent chain.
describe('queryLogs — sessionId filter', () => {
  it('returns only rows whose session_id matches', () => {
    const { sqlite, db } = createInMemoryDb()
    try {
      const now = Date.now()
      db.insert(requests)
        .values({
          id: 'r-A1',
          sourceAgent: 'openclaw',
          args: '{}',
          riskScore: 0,
          decision: 'allowed',
          decidedBy: 'auto',
          createdAt: now,
          sessionId: 'session-A',
        })
        .run()
      db.insert(requests)
        .values({
          id: 'r-A2',
          sourceAgent: 'hermes',
          args: '{}',
          riskScore: 0,
          decision: 'allowed',
          decidedBy: 'auto',
          createdAt: now + 1,
          sessionId: 'session-A',
          parentRequestId: 'r-A1',
        })
        .run()
      db.insert(requests)
        .values({
          id: 'r-B1',
          sourceAgent: 'openclaw',
          args: '{}',
          riskScore: 0,
          decision: 'allowed',
          decidedBy: 'auto',
          createdAt: now + 2,
          sessionId: 'session-B',
        })
        .run()
      const a = queryLogs(sqlite, { sessionId: 'session-A' })
      expect(a.rows.map((r) => r.id).sort()).toEqual(['r-A1', 'r-A2'])
      const b = queryLogs(sqlite, { sessionId: 'session-B' })
      expect(b.rows.map((r) => r.id)).toEqual(['r-B1'])
    } finally {
      sqlite.close()
    }
  })

  it('returns rows with parentRequestId + sessionId populated on read', () => {
    const { sqlite, db } = createInMemoryDb()
    try {
      const now = Date.now()
      db.insert(requests)
        .values({
          id: 'r-1',
          sourceAgent: 'hermes',
          args: '{}',
          riskScore: 0,
          decision: 'allowed',
          decidedBy: 'auto',
          createdAt: now,
          sessionId: 'session-X',
          parentRequestId: 'parent-Y',
        })
        .run()
      const result = queryLogs(sqlite)
      expect(result.rows[0]!.sessionId).toBe('session-X')
      expect(result.rows[0]!.parentRequestId).toBe('parent-Y')
    } finally {
      sqlite.close()
    }
  })

  it('omitting sessionId returns all rows (no implicit filter)', () => {
    const { sqlite, db } = createInMemoryDb()
    try {
      db.insert(requests)
        .values({
          id: 'r-1',
          sourceAgent: 'hermes',
          args: '{}',
          riskScore: 0,
          decision: 'allowed',
          decidedBy: 'auto',
          createdAt: Date.now(),
        })
        .run()
      const result = queryLogs(sqlite, {})
      expect(result.rows).toHaveLength(1)
    } finally {
      sqlite.close()
    }
  })
})
