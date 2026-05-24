import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EventBus,
  type ForemanEventMap,
} from '../../src/core/event-bus.js'
import { PendingQuestionsService } from '../../src/core/pending-questions.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { pendingQuestions } from '../../src/db/schema.js'

// =============================================================================
// PendingQuestionsService (#528) — DB layer + resolution waiter behind the
// `ask_user_with_options` MCP tool. The ask() path inserts + polls; the
// answer/abandon/expireStale paths flip the row + emit `question:answered`.
// =============================================================================

const SAMPLE_OPTIONS = [
  { id: 'opt-shadcn', label: 'shadcn/ui (recommended)' },
  { id: 'opt-custom', label: 'Custom build' },
]

describe('PendingQuestionsService', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let service: PendingQuestionsService

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    service = new PendingQuestionsService(db, { bus, pollIntervalMs: 10 })
  })

  afterEach(() => {
    sqlite.close()
  })

  describe('ask()', () => {
    it('inserts a pending row with the question + options + deadline', async () => {
      const asked = vi.fn()
      bus.on('question:asked', asked)
      const promise = service.ask({
        sourceAgent: 'hermes',
        question: 'shadcn/ui or custom?',
        options: SAMPLE_OPTIONS,
        timeoutMs: 100, // short so the test doesn't hang
      })
      // Give the insert a tick to land before we inspect the row.
      await new Promise((r) => setTimeout(r, 5))
      const row = db.select().from(pendingQuestions).all()[0]!
      expect(row.sourceAgent).toBe('hermes')
      expect(row.question).toBe('shadcn/ui or custom?')
      expect(row.status).toBe('pending')
      expect(row.deadlineMs).toBeGreaterThan(row.requestedAt)
      expect(asked).toHaveBeenCalledOnce()
      await promise // let the timeout fire so afterEach can close cleanly
    })

    it('resolves with outcome=answered when a tap lands before the deadline', async () => {
      const promise = service.ask({
        sourceAgent: 'hermes',
        question: 'shadcn/ui or custom?',
        options: SAMPLE_OPTIONS,
        timeoutMs: 5000,
      })
      await new Promise((r) => setTimeout(r, 20))
      const row = db.select().from(pendingQuestions).all()[0]!
      const ans = service.answer({
        questionId: row.id,
        chosenOptionId: 'opt-shadcn',
        answeredBy: 'tg-user-1',
      })
      expect(ans.ok).toBe(true)
      const resolution = await promise
      expect(resolution.outcome).toBe('answered')
      expect(resolution.chosenOptionId).toBe('opt-shadcn')
      expect(resolution.label).toBe('shadcn/ui (recommended)')
      expect(resolution.answeredBy).toBe('tg-user-1')
    })

    it('resolves with outcome=timeout when no answer lands', async () => {
      const answered = vi.fn()
      bus.on('question:answered', answered)
      const resolution = await service.ask({
        sourceAgent: 'hermes',
        question: 'never answered?',
        options: SAMPLE_OPTIONS,
        timeoutMs: 50,
      })
      expect(resolution.outcome).toBe('timeout')
      expect(resolution.chosenOptionId).toBeUndefined()
      expect(answered).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'timeout' }),
      )
      // Row flipped to status=timeout so a late tap doesn't double-resolve.
      const row = db.select().from(pendingQuestions).all()[0]!
      expect(row.status).toBe('timeout')
    })

    it('resolves with outcome=abandoned when the user dismisses (/cancel)', async () => {
      const promise = service.ask({
        sourceAgent: 'hermes',
        question: 'cancel-able',
        options: SAMPLE_OPTIONS,
        timeoutMs: 5000,
      })
      await new Promise((r) => setTimeout(r, 20))
      const row = db.select().from(pendingQuestions).all()[0]!
      const ok = service.abandon(row.id, 'tg-user-1')
      expect(ok).toBe(true)
      const resolution = await promise
      expect(resolution.outcome).toBe('abandoned')
      expect(resolution.answeredBy).toBe('tg-user-1')
    })

    it('routes free-text replies back through resolution when allowFreeText is true', async () => {
      const promise = service.ask({
        sourceAgent: 'hermes',
        question: 'free text ok?',
        options: SAMPLE_OPTIONS,
        allowFreeText: true,
        timeoutMs: 5000,
      })
      await new Promise((r) => setTimeout(r, 20))
      const row = db.select().from(pendingQuestions).all()[0]!
      const ans = service.answer({
        questionId: row.id,
        freeText: 'custom please',
      })
      expect(ans.ok).toBe(true)
      const resolution = await promise
      expect(resolution.outcome).toBe('answered')
      expect(resolution.freeText).toBe('custom please')
      expect(resolution.chosenOptionId).toBeUndefined()
    })
  })

  describe('answer() validation', () => {
    it('returns ok=false for an unknown question id', () => {
      const out = service.answer({
        questionId: 'nope',
        chosenOptionId: 'opt-shadcn',
      })
      expect(out.ok).toBe(false)
      expect(out.error).toMatch(/not found/)
    })

    it('returns ok=false for a question that already resolved', async () => {
      const promise = service.ask({
        sourceAgent: 'hermes',
        question: 'q',
        options: SAMPLE_OPTIONS,
        timeoutMs: 5000,
      })
      await new Promise((r) => setTimeout(r, 20))
      const row = db.select().from(pendingQuestions).all()[0]!
      service.answer({ questionId: row.id, chosenOptionId: 'opt-shadcn' })
      const second = service.answer({
        questionId: row.id,
        chosenOptionId: 'opt-custom',
      })
      expect(second.ok).toBe(false)
      expect(second.error).toMatch(/already/)
      await promise
    })

    it('rejects free-text answers when allowFreeText=false', async () => {
      const promise = service.ask({
        sourceAgent: 'hermes',
        question: 'strict choice?',
        options: SAMPLE_OPTIONS,
        allowFreeText: false,
        timeoutMs: 5000,
      })
      await new Promise((r) => setTimeout(r, 20))
      const row = db.select().from(pendingQuestions).all()[0]!
      const out = service.answer({
        questionId: row.id,
        freeText: 'something else',
      })
      expect(out.ok).toBe(false)
      expect(out.error).toMatch(/does not allow free-text/)
      // Resolve with a valid option so the polling unblocks.
      service.answer({ questionId: row.id, chosenOptionId: 'opt-shadcn' })
      await promise
    })

    it('rejects an option id that wasn\'t offered', async () => {
      const promise = service.ask({
        sourceAgent: 'hermes',
        question: 'q',
        options: SAMPLE_OPTIONS,
        timeoutMs: 5000,
      })
      await new Promise((r) => setTimeout(r, 20))
      const row = db.select().from(pendingQuestions).all()[0]!
      const out = service.answer({
        questionId: row.id,
        chosenOptionId: 'opt-not-offered',
      })
      expect(out.ok).toBe(false)
      expect(out.error).toMatch(/not offered/)
      service.answer({ questionId: row.id, chosenOptionId: 'opt-shadcn' })
      await promise
    })

    it('requires either chosenOptionId or freeText', async () => {
      const promise = service.ask({
        sourceAgent: 'hermes',
        question: 'q',
        options: SAMPLE_OPTIONS,
        timeoutMs: 5000,
      })
      await new Promise((r) => setTimeout(r, 20))
      const row = db.select().from(pendingQuestions).all()[0]!
      const out = service.answer({ questionId: row.id })
      expect(out.ok).toBe(false)
      expect(out.error).toMatch(/requires/)
      service.answer({ questionId: row.id, chosenOptionId: 'opt-shadcn' })
      await promise
    })
  })

  describe('expireStale + pending list', () => {
    it('expireStale flips stale pending rows to timeout', async () => {
      // Seed a pending row with a past deadline directly so we don't have
      // to actually wait for the polling deadline to elapse.
      db.insert(pendingQuestions)
        .values({
          id: 'q-stale',
          sourceAgent: 'hermes',
          question: 'stale',
          optionsJson: JSON.stringify(SAMPLE_OPTIONS),
          allowFreeText: 1,
          status: 'pending',
          requestedAt: Date.now() - 1000,
          deadlineMs: Date.now() - 100,
        })
        .run()
      const expired = service.expireStale(0)
      expect(expired).toBe(1)
      const row = db.select().from(pendingQuestions).all()[0]!
      expect(row.status).toBe('timeout')
    })

    it('pending() returns only status=pending rows, newest first', () => {
      // Manually seed three rows at different times + statuses.
      db.insert(pendingQuestions)
        .values([
          {
            id: 'q-1',
            sourceAgent: 'hermes',
            question: 'a',
            optionsJson: JSON.stringify(SAMPLE_OPTIONS),
            allowFreeText: 1,
            status: 'pending',
            requestedAt: 1_700_000_000_000,
            deadlineMs: 1_700_000_300_000,
          },
          {
            id: 'q-2',
            sourceAgent: 'hermes',
            question: 'b',
            optionsJson: JSON.stringify(SAMPLE_OPTIONS),
            allowFreeText: 1,
            status: 'answered',
            requestedAt: 1_700_000_001_000,
            deadlineMs: 1_700_000_301_000,
          },
          {
            id: 'q-3',
            sourceAgent: 'hermes',
            question: 'c',
            optionsJson: JSON.stringify(SAMPLE_OPTIONS),
            allowFreeText: 1,
            status: 'pending',
            requestedAt: 1_700_000_002_000,
            deadlineMs: 1_700_000_302_000,
          },
        ])
        .run()
      const pending = service.pending()
      expect(pending.map((p) => p.id)).toEqual(['q-3', 'q-1'])
    })

    it('get() returns the raw row or null', () => {
      expect(service.get('nope')).toBeNull()
    })
  })
})
