import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { InboxRecorder, InboxService, recordDelegationOutcome } from '../../src/core/inbox.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { requests } from '../../src/db/schema.js'

const approvalRequested = (requestId: string): ForemanEventMap['approval:requested'] => ({
  requestId,
  sourceAgent: 'claude-code',
  targetTool: 'read_file',
  args: { path: '.env' },
  riskScore: 80,
  riskReasons: ['secret_path'],
  riskFactors: [],
  riskBucket: 'high',
  llmVerification: null,
  securityReport: null,
})

describe('InboxService', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let inbox: InboxService

  beforeEach(() => {
    ;({ db, sqlite } = createInMemoryDb())
    bus = new EventBus<ForemanEventMap>()
    inbox = new InboxService(db, bus)
  })
  afterEach(() => {
    sqlite.close()
  })

  it('adds, dedupes, counts and marks read', () => {
    const added: string[] = []
    bus.on('inbox:added', (e) => added.push(e.item.title))
    expect(inbox.add({ level: 'warning', kind: 'system', title: 'one', dedupeKey: 'k1' })).not.toBeNull()
    expect(inbox.add({ level: 'warning', kind: 'system', title: 'one again', dedupeKey: 'k1' })).toBeNull()
    const two = inbox.add({ level: 'critical', kind: 'block', title: 'two' })!
    expect(added).toEqual(['one', 'two'])
    expect(inbox.unreadCount()).toBe(2)
    inbox.markRead(two.id)
    expect(inbox.unreadCount()).toBe(1)
    expect(inbox.markAllRead()).toBe(1)
    expect(inbox.unreadCount()).toBe(0)
  })

  it('filters by level and unread, newest first', () => {
    inbox.add({ level: 'info', kind: 'system', title: 'a', createdAt: 1 })
    inbox.add({ level: 'warning', kind: 'system', title: 'b', createdAt: 2 })
    inbox.add({ level: 'critical', kind: 'system', title: 'c', createdAt: 3, read: true })
    expect(inbox.list().map((i) => i.title)).toEqual(['c', 'b', 'a'])
    expect(inbox.list({ minLevel: 'warning' }).map((i) => i.title)).toEqual(['c', 'b'])
    expect(inbox.list({ unreadOnly: true }).map((i) => i.title)).toEqual(['b', 'a'])
  })

  it('never stores secrets and keeps titles to one line', () => {
    const item = inbox.add({
      level: 'warning',
      kind: 'system',
      title: `token ghp_${'x'.repeat(36)}\nsecond line`,
    })!
    expect(item.title).not.toContain('ghp_')
    expect(item.title).not.toContain('\n')
  })

  it('prunes to the newest items', () => {
    for (let i = 0; i < 10; i++) inbox.add({ level: 'info', kind: 'system', title: `n${i}`, createdAt: i })
    inbox.prune(4)
    expect(inbox.list().map((i) => i.title)).toEqual(['n9', 'n8', 'n7', 'n6'])
  })
})

describe('InboxRecorder', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let inbox: InboxService
  let recorder: InboxRecorder

  beforeEach(() => {
    ;({ db, sqlite } = createInMemoryDb())
    bus = new EventBus<ForemanEventMap>()
    inbox = new InboxService(db, bus)
    recorder = new InboxRecorder(db, inbox, { bus, pollIntervalMs: 60_000, now: () => 1_000 })
    recorder.start()
  })
  afterEach(() => {
    recorder.stop()
    sqlite.close()
  })

  it('records an approval, then files it as handled when the user decides in the TUI', () => {
    bus.emit('approval:requested', approvalRequested('r1'))
    expect(inbox.list({ unreadOnly: true }).map((i) => i.title)).toEqual([
      'Approval needed: claude-code → read_file',
    ])
    bus.emit('approval:resolved', { requestId: 'r1', decision: 'denied', resolvedBy: 'user', via: 'tui' })
    expect(inbox.unreadCount()).toBe(0)
    expect(inbox.list()[0]!.title).toBe('Denied read_file for claude-code')
  })

  it('keeps a timed-out approval unread so the user sees what they missed', () => {
    bus.emit('approval:requested', approvalRequested('r2'))
    bus.emit('approval:resolved', { requestId: 'r2', decision: 'denied', resolvedBy: 'timeout' })
    const unread = inbox.list({ unreadOnly: true })
    expect(unread.map((i) => i.title)).toEqual(['Denied read_file for claude-code'])
    expect(unread[0]!.body).toContain('nobody answered')
  })

  it('records calls Foreman blocked on its own, not the ones the user denied', () => {
    const base: ForemanEventMap['request:decided'] = {
      requestId: 'r3',
      sourceAgent: 'hermes',
      targetTool: 'shell_exec',
      args: {},
      decision: 'denied',
      decidedBy: 'risk:critical',
      riskScore: 95,
      riskReasons: ['rm -rf'],
      riskFactors: [],
      riskBucket: 'critical',
      llmVerification: null,
      securityReport: null,
      durationMs: 1,
      createdAt: 2_000,
      decidedAt: 2_000,
    }
    bus.emit('request:decided', base)
    bus.emit('request:decided', { ...base, requestId: 'r4', decidedBy: 'user:tui' })
    const items = inbox.list()
    expect(items.map((i) => [i.level, i.title])).toEqual([['critical', 'Blocked shell_exec from hermes']])
  })

  it('records protective session halts, not the close of a finished task', () => {
    const halt = { turnCount: 12, tokenCount: 9000, haltedAt: 3_000 }
    bus.emit('session:halted', { sessionId: 's1', reason: 'manual', ...halt })
    bus.emit('session:halted', { sessionId: 's2', reason: 'loop_detection', ...halt })
    expect(inbox.list().map((i) => i.title)).toEqual(['Session halted: loop detection'])
  })

  it('picks up blocks decided in other processes from the audit table, once', () => {
    const row = {
      id: 'r5',
      sourceAgent: 'codex',
      targetTool: 'network_fetch',
      args: '{}',
      riskScore: 70,
      riskReasons: JSON.stringify(['exfiltration']),
      riskBucket: 'high' as const,
      decision: 'denied' as const,
      decidedBy: 'policy:12',
      createdAt: 5_000,
      decidedAt: 5_000,
    }
    db.insert(requests).values(row).run()
    db.insert(requests).values({ ...row, id: 'r6', decidedBy: 'user' }).run()
    db.insert(requests).values({ ...row, id: 'r7', createdAt: 500 }).run() // before the recorder started
    recorder.poll()
    recorder.poll()
    expect(inbox.list().map((i) => i.title)).toEqual(['Blocked network_fetch from codex'])
  })
})

describe('recordDelegationOutcome', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let inbox: InboxService

  beforeEach(() => {
    ;({ db, sqlite } = createInMemoryDb())
    inbox = new InboxService(db)
  })
  afterEach(() => {
    sqlite.close()
  })

  it("files the agent's last words on success, and why it failed otherwise", () => {
    recordDelegationOutcome(inbox, {
      controlId: 1,
      agentId: 'codex',
      task: 'write tests for src/rate-limit.ts',
      spawn: { kind: 'ok', stdout: 'thinking…\nAdded 6 tests.\nAll green.' },
    })
    recordDelegationOutcome(inbox, {
      controlId: 2,
      agentId: 'claude-code',
      task: 'add rate limiting',
      spawn: { kind: 'spawn-error', error: 'spawn claude ENOENT' },
    })
    // Retried drains don't duplicate.
    recordDelegationOutcome(inbox, { controlId: 2, agentId: 'claude-code', task: 'x', spawn: { kind: 'timeout', timeoutMs: 1 } })
    const [failed, ok] = inbox.list()
    expect([ok!.level, ok!.title, ok!.body]).toEqual([
      'info',
      'codex finished: write tests for src/rate-limit.ts',
      'thinking… Added 6 tests. All green.',
    ])
    expect([failed!.level, failed!.title, failed!.body]).toEqual([
      'warning',
      "Couldn't start claude-code: add rate limiting",
      'spawn claude ENOENT',
    ])
    expect(inbox.list()).toHaveLength(2)
  })
})
