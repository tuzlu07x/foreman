import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ApprovalDecision,
  type ApprovalService,
} from '../../../src/core/approval.js'
import { AuditLogger } from '../../../src/core/audit.js'
import {
  EventBus,
  type ForemanEventMap,
} from '../../../src/core/event-bus.js'
import { MediatorService } from '../../../src/core/mediator.js'
import { PolicyEngine } from '../../../src/core/policy-engine.js'
import { RegistryService } from '../../../src/core/registry.js'
import { RiskScorer } from '../../../src/core/risk-scorer.js'
import { SessionManager } from '../../../src/core/session.js'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'
import { requests } from '../../../src/db/schema.js'

// End-to-end: drive a ping-pong sequence through the real mediator stack,
// verify the audit row carries a loop factor + that sessionId propagates so
// the modal could expose `[k] halt session`.

describe('loop-detection end-to-end (#229 acceptance criterion)', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let audit: AuditLogger
  let mediator: MediatorService
  let sessionManager: SessionManager

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    audit = new AuditLogger(db, bus)
    const registry = new RegistryService(db, bus)
    const policy = new PolicyEngine(db, bus)
    const risk = new RiskScorer(db, undefined, {
      bucketOverrides: () => policy.getBucketOverrides(),
    })
    const approval: ApprovalService = {
      request: vi.fn(
        async (): Promise<ApprovalDecision> => ({ decision: 'denied' }),
      ),
    }
    sessionManager = new SessionManager(db, { bus, turnLimit: 100 })
    mediator = new MediatorService({
      registry,
      policy,
      risk,
      approval,
      sessionManager,
      bus,
    })
  })

  afterEach(() => {
    audit.dispose()
    sqlite.close()
  })

  it('a ping-pong sequence persists a loop_pingpong factor on the 4th turn', async () => {
    const sessionId = sessionManager.startSession(['hermes', 'claude'])
    const turns: Array<{ from: string; to: string }> = [
      { from: 'hermes', to: 'claude' },
      { from: 'claude', to: 'hermes' },
      { from: 'hermes', to: 'claude' },
      { from: 'claude', to: 'hermes' },
    ]
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i]!
      await mediator.handleRequest({
        requestId: `pp-${i}`,
        sourceAgent: t.from,
        targetAgent: t.to,
        targetTool: 'echo',
        message: {
          jsonrpc: '2.0',
          id: i,
          method: 'tools/call',
          params: { name: 'echo', arguments: { text: `turn ${i}` } },
        } as never,
        sessionId,
      })
      audit.flush()
    }

    // The last turn's persisted row should carry the loop_pingpong factor.
    const last = db
      .select()
      .from(requests)
      .all()
      .find((r) => r.id === 'pp-3')!
    const factors = JSON.parse(last.riskFactors ?? '[]') as Array<{
      rule: string
    }>
    expect(factors.some((f) => f.rule === 'loop_pingpong')).toBe(true)
  })

  it('approval:requested for a loop-flagged call carries sessionId for the modal', async () => {
    const sessionId = sessionManager.startSession(['hermes', 'claude'])
    const seen: ForemanEventMap['approval:requested'][] = []
    bus.on('approval:requested', (e) => seen.push(e))

    // Seed enough alternation to trip ping-pong on the 4th turn
    const turns = [
      { from: 'hermes', to: 'claude' },
      { from: 'claude', to: 'hermes' },
      { from: 'hermes', to: 'claude' },
      { from: 'claude', to: 'hermes' },
    ]
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i]!
      await mediator.handleRequest({
        requestId: `pp2-${i}`,
        sourceAgent: t.from,
        targetAgent: t.to,
        targetTool: 'read_file',
        message: {
          jsonrpc: '2.0',
          id: i,
          method: 'tools/call',
          params: { name: 'read_file', arguments: { path: 'src/auth.ts' } },
        } as never,
        sessionId,
      })
      // Audit batches every 100ms — flush so the next turn's loop rule sees
      // the prior turns in the requests table.
      audit.flush()
    }

    // At least one of the approval requests should carry the loop factor + sessionId
    const loopFlagged = seen.find((e) =>
      e.riskFactors.some((f) => f.rule === 'loop_pingpong'),
    )
    expect(loopFlagged).toBeDefined()
    expect(loopFlagged!.sessionId).toBe(sessionId)
  })

  it('manual halt via SessionManager records reason loop_detection', () => {
    const sessionId = sessionManager.startSession(['hermes', 'claude'])
    const haltEvents: ForemanEventMap['session:halted'][] = []
    bus.on('session:halted', (e) => haltEvents.push(e))

    sessionManager.halt(sessionId, 'loop_detection')
    expect(haltEvents).toHaveLength(1)
    expect(haltEvents[0]!.reason).toBe('loop_detection')
    expect(sessionManager.isHalted(sessionId)).toBe(true)
  })
})
