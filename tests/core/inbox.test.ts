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

  it('prunes exactly, even when items share a millisecond', () => {
    for (let i = 0; i < 5; i++) inbox.add({ level: 'info', kind: 'system', title: `s${i}`, createdAt: 42 })
    inbox.prune(3)
    expect(inbox.list().map((i) => i.title)).toEqual(['s4', 's3', 's2'])
  })

  it('strips terminal escape sequences from agent-quoted text', () => {
    const item = inbox.add({
      level: 'warning',
      kind: 'agent',
      title: 'codex said \x1b]52;c;ZXZpbA==\x07hi\x1b[2J there',
      body: 'red \x1b[31mtext\x1b[0m\u0007 done',
    })!
    expect(item.title).toBe('codex said hi there')
    expect(item.body).toBe('red text done')
  })

  it('upserts by dedupe key so a later, truer record replaces an earlier one', () => {
    inbox.add({ level: 'info', kind: 'approval', title: 'Allowed x', dedupeKey: 'k', read: true })
    const saved = inbox.upsert({ level: 'warning', kind: 'approval', title: 'Denied x', dedupeKey: 'k' })
    expect(saved.title).toBe('Denied x')
    expect(inbox.list().map((i) => [i.title, i.readAt])).toEqual([['Denied x', null]])
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
    recorder = new InboxRecorder(db, inbox, { bus, pollIntervalMs: 60_000 })
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
    recorder.stop()
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
    // Decided before the recorder started: history, not news.
    db.insert(requests).values({ ...row, id: 'r7', targetTool: 'old_tool' }).run()
    recorder = new InboxRecorder(db, inbox, { bus, pollIntervalMs: 60_000 })
    recorder.start()
    db.insert(requests).values(row).run()
    db.insert(requests).values({ ...row, id: 'r6', decidedBy: 'user' }).run()
    recorder.poll()
    // A slow request (LLM verification) that started earlier but was
    // written after the last poll is still news.
    db.insert(requests).values({ ...row, id: 'r8', targetTool: 'slow_tool', createdAt: 100 }).run()
    recorder.poll()
    recorder.poll()
    expect(inbox.list().map((i) => i.title).sort()).toEqual([
      'Blocked network_fetch from codex',
      'Blocked slow_tool from codex',
    ])
  })

  it('keeps a timeout notice unread when the audit poll saw it first', () => {
    bus.emit('approval:requested', approvalRequested('r9'))
    db.insert(requests)
      .values({
        id: 'r9',
        sourceAgent: 'claude-code',
        targetTool: 'read_file',
        args: '{}',
        riskScore: 80,
        riskReasons: '[]',
        riskBucket: 'high',
        decision: 'denied',
        decidedBy: 'approval-timeout',
        createdAt: 1,
        decidedAt: 2,
      })
      .run()
    recorder.poll()
    bus.emit('approval:resolved', { requestId: 'r9', decision: 'denied', resolvedBy: 'timeout' })
    const unread = inbox.list({ unreadOnly: true })
    expect(unread).toHaveLength(1)
    expect(unread[0]!.title).toContain('Denied read_file for claude-code')
  })

  it('lets the decision that actually counted replace one that lost a race', () => {
    bus.emit('approval:requested', approvalRequested('r10'))
    // The TUI decided, but another process had already denied it; the
    // bridge then announces the real outcome.
    bus.emit('approval:resolved', { requestId: 'r10', decision: 'allowed', resolvedBy: 'user', via: 'tui' })
    bus.emit('approval:resolved', { requestId: 'r10', decision: 'denied', resolvedBy: 'timeout' })
    const items = inbox.list().filter((i) => i.dedupeKey === 'approval:r10:resolved')
    expect(items.map((i) => [i.title, i.readAt])).toEqual([['Denied read_file for claude-code', null]])
  })

  it('names the teammate who decided in Slack or Discord, and says "you" elsewhere', () => {
    bus.emit('approval:requested', approvalRequested('r13'))
    bus.emit('approval:resolved', { requestId: 'r13', decision: 'allowed', resolvedBy: 'user', via: 'slack', userId: 'U0BOSS' })
    bus.emit('approval:requested', approvalRequested('r14'))
    bus.emit('approval:resolved', { requestId: 'r14', decision: 'denied', resolvedBy: 'user', via: 'discord', userId: '111111111111111111' })
    bus.emit('approval:requested', approvalRequested('r15'))
    bus.emit('approval:resolved', { requestId: 'r15', decision: 'denied', resolvedBy: 'user', via: 'telegram', userId: '42' })
    bus.emit('approval:requested', approvalRequested('r16'))
    bus.emit('approval:resolved', { requestId: 'r16', decision: 'denied', resolvedBy: 'user', via: 'slack' })
    const body = (id: string) => inbox.list().find((i) => i.dedupeKey === `approval:${id}:resolved`)!.body
    expect(body('r13')).toBe('by U0BOSS via Slack')
    expect(body('r14')).toBe('by 111111111111111111 via Discord')
    expect(body('r15')).toBe('by you via Telegram')
    expect(body('r16')).toBe('by you via Slack')
  })

  it('files a withdrawn request quietly', () => {
    bus.emit('approval:requested', approvalRequested('r11'))
    bus.emit('approval:resolved', { requestId: 'r11', decision: 'denied', resolvedBy: 'cancelled' })
    expect(inbox.unreadCount()).toBe(0)
    expect(inbox.list()[0]!.body).toContain('stopped waiting')
  })

  it('never breaks the listeners after it when a write fails', () => {
    const seen: string[] = []
    bus.on('approval:requested', (e) => seen.push(e.requestId))
    inbox.add = () => {
      throw new Error('SQLITE_BUSY')
    }
    expect(() => bus.emit('approval:requested', approvalRequested('r12'))).not.toThrow()
    expect(seen).toEqual(['r12'])
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
