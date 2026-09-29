import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { InboxService, recordMissedApprovals, waitingApprovalCount } from '../../src/core/inbox.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { pendingApprovals, requests } from '../../src/db/schema.js'

// QA #657 M2 — with no `foreman start` running, an approval timed out,
// was denied, and left no trace: `foreman inbox` said "all caught up".
describe('approvals that timed out while Foreman was not running', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let inbox: InboxService
  const now = Date.now()

  const timedOut = (id: string, createdAt = now - 60_000, tool = 'shell_exec'): void => {
    db.insert(requests)
      .values({
        id,
        sourceAgent: 'qa-bot',
        targetTool: tool,
        args: '{}',
        riskScore: 70,
        riskBucket: 'high',
        decision: 'denied',
        decidedBy: 'approval-timeout',
        createdAt,
        decidedAt: createdAt + 3_000,
      })
      .run()
  }

  beforeEach(() => {
    ;({ db, sqlite } = createInMemoryDb())
    inbox = new InboxService(db)
  })
  afterEach(() => {
    sqlite.close()
  })

  it('leaves one unread summary saying what to do, and a read item per call', () => {
    timedOut('r1')
    timedOut('r2', now - 30_000, 'read_file')
    expect(recordMissedApprovals(db, inbox, now)).toBe(2)
    const unread = inbox.list({ unreadOnly: true })
    expect(unread.map((i) => i.title)).toEqual([
      "2 approvals timed out while Foreman wasn't running",
    ])
    expect(unread[0]?.body).toBe(
      'Denied: shell_exec for qa-bot, read_file for qa-bot. ' +
        'To be asked next time, keep Foreman running: `foreman start` or the background service (`foreman service install`).',
    )
    // Often read in a running TUI: never "start `foreman start` to approve".
    expect(unread[0]?.title).not.toContain('to approve')
    const all = inbox.list().map((i) => i.title)
    expect(all).toContain('Denied shell_exec for qa-bot (no answer in time)')
    expect(all).toContain('Denied read_file for qa-bot (no answer in time)')
  })

  it('counts each approval once', () => {
    timedOut('r1')
    expect(recordMissedApprovals(db, inbox, now)).toBe(1)
    expect(recordMissedApprovals(db, inbox, now)).toBe(0)
    timedOut('r3', now - 1_000)
    expect(recordMissedApprovals(db, inbox, now)).toBe(1)
    expect(inbox.unreadCount()).toBe(2)
  })

  it('skips approvals a running foreman start showed, and old ones', () => {
    timedOut('seen')
    inbox.add({ level: 'warning', kind: 'approval', title: 'Approval needed', dedupeKey: 'approval:seen:requested' })
    timedOut('ancient', now - 30 * 24 * 60 * 60 * 1000)
    expect(recordMissedApprovals(db, inbox, now)).toBe(0)
  })

  it('counts approvals still waiting for an answer', () => {
    const row = {
      sourceAgent: 'qa-bot',
      args: '{}',
      riskScore: 70,
      riskReasons: '[]',
      status: 'pending' as const,
      requestedAt: now,
    }
    db.insert(pendingApprovals).values({ ...row, requestId: 'w1', deadlineMs: now + 60_000 }).run()
    db.insert(pendingApprovals).values({ ...row, requestId: 'w2', deadlineMs: now - 1 }).run()
    expect(waitingApprovalCount(db, now)).toBe(1)
  })
})
