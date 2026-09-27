import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DbApprovalService } from '../../../src/core/approval.js'
import { approvalTag, formatApprovalToken } from '../../../src/core/approval-token.js'
import { EventBus, type ForemanEventMap } from '../../../src/core/event-bus.js'
import { InboxService } from '../../../src/core/inbox.js'
import { OrgComms, renderMessages } from '../../../src/core/org/comms.js'
import { parseOrgText, reviewLinesFor } from '../../../src/core/org/org.js'
import {
  ApprovalReviews,
  ApprovalReviewWorker,
  formatRecommendation,
  MAX_REASON,
  type EscalationRequest,
} from '../../../src/core/org/review.js'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'
import { approvalReviews, pendingApprovals } from '../../../src/db/schema.js'

// #623 — approval escalation along reporting lines. A manager agent may
// recommend; only the human decides.

const ORG = `version: 1
company: Acme
approvals:
  escalate_via_manager: true
departments:
  engineering: { name: Engineering, head: cto }
  marketing: { name: Marketing, head: cmo }
roles:
  cto: { title: CTO, agent: claude-code, department: engineering, reports_to: human }
  engineer: { title: Engineer, agent: codex, department: engineering, reports_to: cto }
  reviewer: { title: Reviewer, agent: gemini, department: engineering, reports_to: cto }
  cmo: { title: CMO, agent: hermes, department: marketing, reports_to: human }
`

const FAKE_KEY = 'sk-ant-api03-' + 'A'.repeat(90)

describe('approval escalation along reporting lines (#623)', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let dir: string
  let orgPath: string
  let comms: OrgComms
  let reviews: ApprovalReviews
  let now: number

  const request = (overrides: Partial<EscalationRequest> = {}): EscalationRequest => ({
    requestId: '01J9ZZZZZZZZZZZZZZZZZZZZZ1',
    sourceAgent: 'codex',
    targetTool: 'shell_exec',
    args: { command: 'npm publish', token: FAKE_KEY },
    riskScore: 45,
    riskReasons: ['shell_exec', 'network_outbound'],
    riskBucket: 'medium',
    deadlineMs: now + 10 * 60_000,
    ...overrides,
  })

  /** A DB-backed approval, as `foreman mcp-stdio` writes it. */
  const pending = (requestId: string, bucket: 'low' | 'medium' | 'high' | 'critical' = 'medium') => {
    db.insert(pendingApprovals)
      .values({
        requestId,
        sourceAgent: 'codex',
        targetTool: 'shell_exec',
        args: '{}',
        riskScore: 45,
        riskReasons: '[]',
        riskBucket: bucket,
        status: 'pending',
        requestedAt: now,
        deadlineMs: now + 600_000,
      })
      .run()
  }

  const approvalRow = (requestId: string) =>
    db.select().from(pendingApprovals).where(eq(pendingApprovals.requestId, requestId)).get()

  const writeOrg = (text: string) => {
    writeFileSync(orgPath, text)
    // OrgComms caches by mtime; make sure the rewrite is seen.
    comms = new OrgComms(db, { orgConfigPath: orgPath, now: () => now })
    reviews = new ApprovalReviews(db, comms, { now: () => now })
  }

  beforeEach(() => {
    ;({ db, sqlite } = createInMemoryDb())
    dir = mkdtempSync(join(tmpdir(), 'foreman-review-'))
    orgPath = join(dir, 'org.yaml')
    now = 1_800_000_000_000
    writeOrg(ORG)
  })
  afterEach(() => {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('org.yaml', () => {
    it('validates approvals.escalate_via_manager', () => {
      expect(parseOrgText(ORG).approvals?.escalate_via_manager).toBe(true)
      expect(parseOrgText(ORG.replace('escalate_via_manager: true', 'escalate_via_manager: false')).approvals).toEqual({
        escalate_via_manager: false,
      })
      expect(() => parseOrgText(ORG.replace('escalate_via_manager: true', 'escalate_via_manager: yes please'))).toThrow(
        /approvals\.escalate_via_manager/,
      )
      expect(() => parseOrgText(ORG.replace('escalate_via_manager: true', 'auto_approve: true'))).toThrow(/approvals/)
      expect(parseOrgText(ORG.replace(/approvals:\n {2}escalate_via_manager: true\n/, '')).approvals).toBeUndefined()
    })

    it('reviewers are manager agents only: never you, never the requester itself', () => {
      const org = parseOrgText(ORG)
      expect(reviewLinesFor(org, 'codex')).toEqual([{ requesterRole: 'engineer', managerRole: 'cto', managerAgent: 'claude-code' }])
      expect(reviewLinesFor(org, 'claude-code')).toEqual([]) // reports to the human
      expect(reviewLinesFor(org, 'cli')).toEqual([])
      expect(reviewLinesFor(org, 'stranger')).toEqual([])
      const selfManaged = parseOrgText(ORG.replace('engineer: { title: Engineer, agent: codex', 'engineer: { title: Engineer, agent: claude-code'))
      expect(reviewLinesFor(selfManaged, 'claude-code')).toEqual([])
    })
  })

  describe('escalation', () => {
    it("posts a structured review request on the manager's thread, with secrets redacted", () => {
      const created = reviews.escalate(request())
      expect(created).toHaveLength(1)
      expect(created[0]).toMatchObject({ managerRole: 'cto', managerAgent: 'claude-code', channel: 'dm:cto|engineer' })
      const [message] = comms.read({ viewer: 'claude-code' })
      expect(message).toMatchObject({ channel: 'dm:cto|engineer', fromAgent: 'foreman', kind: 'review' })
      expect(message!.text).toContain('approval_id: 01J9ZZZZZZZZZZZZZZZZZZZZZ1')
      expect(message!.text).toContain('shell_exec')
      expect(message!.text).toContain('risk: 45/100 (medium)')
      expect(message!.text).toContain('network_outbound')
      expect(message!.text).toContain('npm publish')
      expect(message!.text).not.toContain(FAKE_KEY)
      expect(message!.text).toContain('Advice only: the human decides')
      expect(renderMessages([message!], now, false)).toContain('cto ↔ engineer · foreman [review]')
    })

    it('escalates low risk too, once per approval', () => {
      expect(reviews.escalate(request({ riskBucket: 'low' }))).toHaveLength(1)
      expect(reviews.escalate(request({ riskBucket: 'low' }))).toHaveLength(0)
      expect(comms.read({ viewer: 'claude-code' })).toHaveLength(1)
    })

    it.each(['high', 'critical'] as const)('never escalates %s approvals: they go straight to the human', (bucket) => {
      expect(reviews.escalate(request({ riskBucket: bucket }))).toEqual([])
      expect(db.select().from(approvalReviews).all()).toEqual([])
      expect(comms.read({ viewer: 'claude-code' })).toEqual([])
    })

    it('does nothing when escalation is off, or for an agent without a manager agent', () => {
      expect(reviews.escalate(request({ sourceAgent: 'claude-code' }))).toEqual([])
      expect(reviews.escalate(request({ sourceAgent: 'hermes' }))).toEqual([])
      writeOrg(ORG.replace('escalate_via_manager: true', 'escalate_via_manager: false'))
      expect(reviews.escalate(request())).toEqual([])
      writeOrg('version: 1\ncompany: Broken\nroles: {}\n')
      expect(reviews.escalate(request())).toEqual([])
    })
  })

  describe('recommendations', () => {
    const id = '01J9ZZZZZZZZZZZZZZZZZZZZZ1'
    beforeEach(() => {
      pending(id)
      reviews.escalate(request())
    })

    it("the requester's manager can recommend, and it is recorded on the thread", () => {
      const result = reviews.recommend({ from: 'claude-code', approvalId: `aprv_${id}`, recommendation: 'allow', reason: 'read-only publish dry run' })
      expect(result).toMatchObject({
        ok: true,
        recommendation: {
          approvalId: id,
          managerRole: 'cto',
          managerTitle: 'CTO',
          managerAgent: 'claude-code',
          requesterAgent: 'codex',
          recommendation: 'allow',
          reason: 'read-only publish dry run',
        },
      })
      if (!result.ok) throw new Error('unreachable')
      expect(formatRecommendation(result.recommendation)).toBe('CTO (claude-code) recommends allow: read-only publish dry run')
      const thread = comms.read({ viewer: 'codex', channel: 'cto' })
      expect(thread.map((m) => m.kind)).toEqual(['review', 'recommendation'])
      expect(thread[1]).toMatchObject({ fromAgent: 'claude-code', fromRole: 'cto' })
      expect(reviews.recommendationsFor(id)).toHaveLength(1)
    })

    it('never resolves, extends or shortens the approval', () => {
      const before = approvalRow(id)
      expect(reviews.recommend({ from: 'claude-code', approvalId: id, recommendation: 'allow', reason: 'fine' }).ok).toBe(true)
      expect(approvalRow(id)).toEqual(before)
      expect(approvalRow(id)).toMatchObject({ status: 'pending', decision: null, resolvedBy: null })
    })

    it('rejects anyone but the manager: colleagues, other departments, strangers', () => {
      for (const from of ['gemini', 'hermes', 'stranger']) {
        const r = reviews.recommend({ from, approvalId: id, recommendation: 'allow', reason: 'looks fine' })
        expect(r).toMatchObject({ ok: false })
        if (!r.ok) expect(r.reason).toContain("only engineer's manager can recommend")
      }
      expect(reviews.recommendationsFor(id)).toEqual([])
    })

    it('rejects a recommendation on your own request', () => {
      const r = reviews.recommend({ from: 'codex', approvalId: id, recommendation: 'allow', reason: 'trust me' })
      expect(r).toEqual({ ok: false, reason: 'that is your own request: only the human can decide it' })
    })

    it.each(['cli', 'tui', 'boss', 'human', 'owner', 'foreman', 'telegram', ' CLI '])(
      'rejects a human source (%s): you decide, you do not recommend',
      (from) => {
        const r = reviews.recommend({ from, approvalId: id, recommendation: 'allow', reason: 'x' })
        expect(r).toMatchObject({ ok: false })
        if (!r.ok) expect(r.reason).toContain('you decide approvals yourself')
      },
    )

    it('rejects a manager the chart no longer names, even if it was sent the review', () => {
      writeOrg(ORG.replace('engineer: { title: Engineer, agent: codex, department: engineering, reports_to: cto }', 'engineer: { title: Engineer, agent: codex, department: engineering, reports_to: human }'))
      const r = reviews.recommend({ from: 'claude-code', approvalId: id, recommendation: 'allow', reason: 'x' })
      expect(r).toMatchObject({ ok: false })
    })

    it('rejects once escalation is turned off', () => {
      writeOrg(ORG.replace('escalate_via_manager: true', 'escalate_via_manager: false'))
      expect(reviews.recommend({ from: 'claude-code', approvalId: id, recommendation: 'allow', reason: 'x' })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('escalation is off'),
      })
    })

    it('rejects a second recommendation, bad values, and an empty reason', () => {
      expect(reviews.recommend({ from: 'claude-code', approvalId: id, recommendation: 'approve', reason: 'x' }).ok).toBe(false)
      expect(reviews.recommend({ from: 'claude-code', approvalId: id, recommendation: 'allow', reason: '   ' }).ok).toBe(false)
      expect(reviews.recommend({ from: 'claude-code', approvalId: id, recommendation: 'deny', reason: 'risky' }).ok).toBe(true)
      expect(reviews.recommend({ from: 'claude-code', approvalId: id, recommendation: 'allow', reason: 'changed my mind' })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('already recommended deny'),
      })
    })

    it('rejects an approval that was not sent for review, or is already decided or expired', () => {
      expect(reviews.recommend({ from: 'claude-code', approvalId: '01J9ZZZZZZZZZZZZZZZZZZZZZ9', recommendation: 'allow', reason: 'x' })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('was not sent to anyone for review'),
      })
      db.update(pendingApprovals).set({ status: 'resolved', decision: 'denied', resolvedBy: 'user' }).where(eq(pendingApprovals.requestId, id)).run()
      expect(reviews.recommend({ from: 'claude-code', approvalId: id, recommendation: 'allow', reason: 'x' })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('already decided'),
      })
      expect(db.select().from(approvalReviews).get()!.status).toBe('closed')

      const other = '01J9ZZZZZZZZZZZZZZZZZZZZZ2'
      pending(other)
      reviews.escalate(request({ requestId: other }))
      now += 11 * 60_000
      expect(reviews.recommend({ from: 'claude-code', approvalId: other, recommendation: 'allow', reason: 'x' })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('expired'),
      })
    })

    it('redacts and clips the reason like an org message', () => {
      const r = reviews.recommend({
        from: 'claude-code',
        approvalId: id,
        recommendation: 'deny',
        reason: `leaks ${FAKE_KEY}\u001b[31m ${'x'.repeat(2_000)}`,
      })
      if (!r.ok) throw new Error(r.reason)
      expect(r.recommendation.reason).not.toContain(FAKE_KEY)
      expect(r.recommendation.reason).not.toContain('\u001b')
      expect(r.recommendation.reason.length).toBeLessThanOrEqual(MAX_REASON)
    })

    it('an allow recommendation never changes what happens on timeout: the default still denies', async () => {
      const service = new DbApprovalService(db, { timeoutMs: 400, pollIntervalMs: 20 })
      const waiting = service.request({
        requestId: '01J9ZZZZZZZZZZZZZZZZZZZZZ3',
        sourceAgent: 'codex',
        targetTool: 'shell_exec',
        args: {},
        riskScore: 45,
        riskReasons: [],
        riskFactors: [],
        riskBucket: 'medium',
        llmVerification: null,
        securityReport: null,
      })
      await new Promise((r) => setTimeout(r, 50))
      const deadline = approvalRow('01J9ZZZZZZZZZZZZZZZZZZZZZ3')!.deadlineMs
      now = Date.now()
      reviews.escalate(request({ requestId: '01J9ZZZZZZZZZZZZZZZZZZZZZ3', deadlineMs: deadline ?? undefined }))
      expect(
        reviews.recommend({ from: 'claude-code', approvalId: '01J9ZZZZZZZZZZZZZZZZZZZZZ3', recommendation: 'allow', reason: 'ship it' }).ok,
      ).toBe(true)
      expect(approvalRow('01J9ZZZZZZZZZZZZZZZZZZZZZ3')!.deadlineMs).toBe(deadline)
      const decision = await waiting
      expect(decision).toEqual({ decision: 'denied', timedOut: true })
    })

    it('a reviewer cannot turn the id it was handed into a decision', async () => {
      const service = new DbApprovalService(db, { approvalKey: Buffer.alloc(32, 7) })
      expect(reviews.isReviewer(`aprv_${id}.forgedtag`, 'claude-code')).toBe(true)
      expect(reviews.isReviewer(id, 'gemini')).toBe(false)
      for (const decision of ['allow', 'deny'] as const) {
        const r = await service.submitFromAgent({ approvalId: id, decision, sourceAgent: 'claude-code', requireToken: true })
        expect(r.ok).toBe(false)
      }
      reviews.recommend({ from: 'claude-code', approvalId: id, recommendation: 'allow', reason: 'fine' })
      const r = await service.submitFromAgent({ approvalId: id, decision: 'allow', sourceAgent: 'claude-code', requireToken: true })
      expect(r.ok).toBe(false)
      expect(approvalRow(id)!.status).toBe('pending')
      // Without an approval key, a reviewer can't decide at all.
      const keyless = new DbApprovalService(db)
      expect((await keyless.submitFromAgent({ approvalId: id, decision: 'deny', sourceAgent: 'claude-code', requireToken: true })).ok).toBe(false)
      expect(approvalRow(id)!.status).toBe('pending')
      // The human's own tap (carrying Foreman's token) still counts when the
      // reviewer is also the chat agent relaying it.
      const tapped = formatApprovalToken(id, approvalTag(Buffer.alloc(32, 7), id, 'deny'))
      expect((await service.submitFromAgent({ approvalId: tapped, decision: 'deny', sourceAgent: 'claude-code', requireToken: true })).ok).toBe(true)
      expect(approvalRow(id)).toMatchObject({ status: 'resolved', decision: 'denied' })
    })
  })

  describe('foreman start worker', () => {
    const id = '01J9ZZZZZZZZZZZZZZZZZZZZZ4'
    const event = (overrides: Partial<ForemanEventMap['approval:requested']> = {}): ForemanEventMap['approval:requested'] => ({
      requestId: id,
      sourceAgent: 'codex',
      targetTool: 'shell_exec',
      args: { command: 'ls' },
      riskScore: 30,
      riskReasons: ['shell_exec'],
      riskFactors: [],
      riskBucket: 'low',
      llmVerification: null,
      securityReport: null,
      deadlineMs: now + 600_000,
      ...overrides,
    })

    it('escalates announced approvals, announces recommendations once, and files them in the inbox', () => {
      const bus = new EventBus<ForemanEventMap>()
      const inbox = new InboxService(db, bus)
      const worker = new ApprovalReviewWorker(reviews, { bus, inbox, intervalMs: 60_000 })
      const announced: ForemanEventMap['approval:recommended'][] = []
      bus.on('approval:recommended', (e) => announced.push(e))
      worker.start()
      try {
        bus.emit('approval:requested', event())
        bus.emit('approval:requested', event({ requestId: '01J9ZZZZZZZZZZZZZZZZZZZZZ5', riskBucket: 'high' }))
        expect(db.select().from(approvalReviews).all().map((r) => r.approvalId)).toEqual([id])

        // Recorded by the manager's own `foreman mcp-stdio` (another process).
        new ApprovalReviews(db, new OrgComms(db, { orgConfigPath: orgPath }), { now: () => now }).recommend({
          from: 'claude-code',
          approvalId: id,
          recommendation: 'deny',
          reason: 'not in the sprint',
        })
        worker.tick()
        worker.tick()
        expect(announced).toHaveLength(1)
        expect(announced[0]).toMatchObject({ approvalId: id, recommendation: 'deny', managerTitle: 'CTO' })
        const [item] = inbox.list()
        expect(item).toMatchObject({ kind: 'approval', requestId: id, readAt: null })
        expect(item!.title).toBe('CTO (claude-code) recommends deny: shell_exec for codex')
        expect(item!.body).toContain('Advice only')

        bus.emit('approval:resolved', { requestId: id, decision: 'allowed', resolvedBy: 'user', via: 'tui' })
        expect(db.select().from(approvalReviews).get()!.status).toBe('closed')
        expect(inbox.list()[0]!.readAt).not.toBeNull()
      } finally {
        worker.stop()
      }
    })

    it('closes reviews left open by an earlier run', () => {
      reviews.escalate(request({ requestId: id }))
      const worker = new ApprovalReviewWorker(reviews, { bus: new EventBus<ForemanEventMap>(), intervalMs: 60_000 })
      pending('01J9ZZZZZZZZZZZZZZZZZZZZZ6')
      reviews.escalate(request({ requestId: '01J9ZZZZZZZZZZZZZZZZZZZZZ6' }))
      db.update(pendingApprovals).set({ status: 'resolved' }).where(eq(pendingApprovals.requestId, '01J9ZZZZZZZZZZZZZZZZZZZZZ6')).run()
      worker.start()
      worker.stop()
      // No pending row: an in-process approval of a run that has exited.
      expect(db.select().from(approvalReviews).all().map((r) => r.status)).toEqual(['closed', 'closed'])
    })
  })
})
