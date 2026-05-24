import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  costByProject,
  costBySession,
  deriveProjectTag,
  listProjectCosts,
  listSessionCosts,
  queryUsage,
  recordUsage,
} from '../../../src/core/llm/budget.js'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'

// =============================================================================
// #530 — Per-project + per-session cost rollup.
//
// Two flavours of test:
//   - recordUsage now accepts sessionId + projectTag and persists them.
//   - The new query helpers (costBySession / costByProject /
//     listSessionCosts / listProjectCosts) group + sum correctly.
//
// All tests use real DB rows (no mocks) — the rollup is a SUM query, so
// integration-style coverage matches what production runs.
// =============================================================================

function seedUsage(
  db: ForemanDb,
  overrides: Partial<{
    feature: string
    provider: string
    model: string
    inputTokens: number
    outputTokens: number
    costUsd: number
    cacheHit: boolean
    requestId: string
    sessionId: string
    projectTag: string
    ts: number
  }> = {},
): string {
  return recordUsage(db, {
    provider: overrides.provider ?? 'anthropic',
    model: overrides.model ?? 'claude-opus-4.7',
    feature: overrides.feature ?? 'verification',
    inputTokens: overrides.inputTokens ?? 1000,
    outputTokens: overrides.outputTokens ?? 200,
    costUsd: overrides.costUsd ?? 0.04,
    durationMs: 1500,
    cacheHit: overrides.cacheHit ?? false,
    ...(overrides.requestId !== undefined
      ? { requestId: overrides.requestId }
      : {}),
    ...(overrides.sessionId !== undefined
      ? { sessionId: overrides.sessionId }
      : {}),
    ...(overrides.projectTag !== undefined
      ? { projectTag: overrides.projectTag }
      : {}),
    ...(overrides.ts !== undefined ? { ts: overrides.ts } : {}),
  })
}

describe('recordUsage with session_id + project_tag (#530)', () => {
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

  it('persists session_id when provided', () => {
    seedUsage(db, { sessionId: 'sess-1', costUsd: 0.10 })
    const rows = queryUsage(db, { sessionId: 'sess-1' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sessionId).toBe('sess-1')
  })

  it('persists project_tag when provided', () => {
    seedUsage(db, { projectTag: 'todo-app' })
    const rows = queryUsage(db, { project: 'todo-app' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.projectTag).toBe('todo-app')
  })

  it('legacy callers (no sessionId, no projectTag) record null cleanly', () => {
    seedUsage(db, {})
    const rows = queryUsage(db, {})
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sessionId).toBeNull()
    expect(rows[0]!.projectTag).toBeNull()
  })
})

describe('costBySession (#530)', () => {
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

  it('sums every llm_usage row tagged with the session', () => {
    seedUsage(db, { sessionId: 'sess-1', costUsd: 0.04, ts: 1_700_000_000_000 })
    seedUsage(db, { sessionId: 'sess-1', costUsd: 0.06, ts: 1_700_000_000_500 })
    seedUsage(db, { sessionId: 'sess-1', costUsd: 0.10, ts: 1_700_000_001_000 })
    // unrelated rows must NOT bleed into the rollup
    seedUsage(db, { sessionId: 'sess-2', costUsd: 99 })
    seedUsage(db, { costUsd: 99 }) // null session
    const summary = costBySession(db, 'sess-1')
    expect(summary.totalUsd).toBeCloseTo(0.20, 6)
    expect(summary.calls).toBe(3)
    expect(summary.firstAt).toBe(1_700_000_000_000)
    expect(summary.lastAt).toBe(1_700_000_001_000)
  })

  it('returns zero-summary for an unknown session id', () => {
    seedUsage(db, { sessionId: 'sess-1', costUsd: 0.10 })
    expect(costBySession(db, 'ghost')).toEqual({
      totalUsd: 0,
      calls: 0,
      firstAt: null,
      lastAt: null,
    })
  })
})

describe('costByProject (#530)', () => {
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

  it('sums + counts sessions for a project tag', () => {
    seedUsage(db, { projectTag: 'todo-app', sessionId: 'sess-1', costUsd: 0.50 })
    seedUsage(db, { projectTag: 'todo-app', sessionId: 'sess-2', costUsd: 0.30 })
    seedUsage(db, { projectTag: 'todo-app', sessionId: 'sess-2', costUsd: 0.40 })
    seedUsage(db, { projectTag: 'other', sessionId: 'sess-3', costUsd: 5.0 })
    const summary = costByProject(db, 'todo-app')
    expect(summary.totalUsd).toBeCloseTo(1.20, 6)
    expect(summary.calls).toBe(3)
    expect(summary.sessions).toBe(2)
  })

  it('honours the since filter (clamps to window)', () => {
    const past = 1_700_000_000_000
    const future = 1_700_000_100_000
    seedUsage(db, { projectTag: 'todo-app', costUsd: 5, ts: past })
    seedUsage(db, { projectTag: 'todo-app', costUsd: 1, ts: future })
    const all = costByProject(db, 'todo-app')
    expect(all.totalUsd).toBeCloseTo(6, 6)
    const recent = costByProject(db, 'todo-app', past + 1)
    expect(recent.totalUsd).toBeCloseTo(1, 6)
  })
})

describe('listProjectCosts + listSessionCosts (#530)', () => {
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

  it('listProjectCosts groups by tag, sorts by spend desc, skips null', () => {
    seedUsage(db, { projectTag: 'cheap', sessionId: 's1', costUsd: 0.01 })
    seedUsage(db, { projectTag: 'big', sessionId: 's2', costUsd: 1.50 })
    seedUsage(db, { projectTag: 'big', sessionId: 's3', costUsd: 0.30 })
    seedUsage(db, { costUsd: 999 }) // untagged — excluded
    const rows = listProjectCosts(db)
    expect(rows.map((r) => r.projectTag)).toEqual(['big', 'cheap'])
    expect(rows[0]!.totalUsd).toBeCloseTo(1.80, 6)
    expect(rows[0]!.sessions).toBe(2)
    expect(rows[1]!.totalUsd).toBeCloseTo(0.01, 6)
  })

  it('listSessionCosts groups by session id, sorts by spend desc, skips null', () => {
    seedUsage(db, { sessionId: 'sa', costUsd: 0.01 })
    seedUsage(db, { sessionId: 'sb', costUsd: 1.0 })
    seedUsage(db, { sessionId: 'sb', costUsd: 0.5 })
    seedUsage(db, { costUsd: 999 })
    const rows = listSessionCosts(db)
    expect(rows.map((r) => r.sessionId)).toEqual(['sb', 'sa'])
    expect(rows[0]!.totalUsd).toBeCloseTo(1.5, 6)
    expect(rows[0]!.calls).toBe(2)
  })
})

describe('queryUsage with project / sessionId filter (#530)', () => {
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

  it('filters by project (exact match)', () => {
    seedUsage(db, { projectTag: 'todo-app', costUsd: 0.10 })
    seedUsage(db, { projectTag: 'other', costUsd: 99 })
    const rows = queryUsage(db, { project: 'todo-app' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.projectTag).toBe('todo-app')
  })

  it('filters by sessionId (exact match)', () => {
    seedUsage(db, { sessionId: 'sess-a', costUsd: 0.10 })
    seedUsage(db, { sessionId: 'sess-b', costUsd: 99 })
    const rows = queryUsage(db, { sessionId: 'sess-a' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sessionId).toBe('sess-a')
  })
})

describe('deriveProjectTag (#530)', () => {
  it('returns the cwd basename', () => {
    expect(deriveProjectTag('/Users/fatih/Projects/todo-app')).toBe('todo-app')
    expect(deriveProjectTag('/Users/fatih/Projects/foreman/')).toBe('foreman')
  })

  it('returns undefined for filesystem-root-ish paths', () => {
    expect(deriveProjectTag('/')).toBeUndefined()
    expect(deriveProjectTag('.')).toBeUndefined()
    expect(deriveProjectTag('')).toBeUndefined()
  })

  it('skips obvious tmp / system roots', () => {
    expect(deriveProjectTag('/tmp')).toBeUndefined()
    expect(deriveProjectTag('/var')).toBeUndefined()
    expect(deriveProjectTag('/Users')).toBeUndefined()
  })

  it('handles Windows-style paths', () => {
    expect(deriveProjectTag('C:\\Users\\fatih\\todo-app')).toBe('todo-app')
  })
})
