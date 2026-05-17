import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ApprovalDecision,
  ApprovalService,
} from '../../src/core/approval.js'
import { AuditLogger } from '../../src/core/audit.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { MediatorService } from '../../src/core/mediator.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { RegistryService } from '../../src/core/registry.js'
import { RiskScorer } from '../../src/core/risk-scorer.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { requests } from '../../src/db/schema.js'
import type { JSONRPCMessage } from '../../src/mcp/types.js'

// =============================================================================
// Tests for #301 — agent-to-agent flow tracking
// =============================================================================
//
// Mediator propagates `sessionId` + `parentRequestId` from input → emitted
// event → audit row. These tests pin the persistence + chain semantics:
//   - first-in-chain: both null
//   - 1-hop delegation: parent points to root, session inherited
//   - 2-hop chain: every row shares sessionId, parent IDs form the tree
//   - concurrent sessions don't cross-pollute

function callMessage(id: number, tool: string, args: unknown): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  } as JSONRPCMessage
}

interface SessionRow {
  id: string
  source_agent: string
  parent_request_id: string | null
  session_id: string | null
}

describe('MediatorService — agent-to-agent flow tracking', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let registry: RegistryService
  let policy: PolicyEngine
  let risk: RiskScorer
  let approval: ApprovalService
  let audit: AuditLogger
  let mediator: MediatorService

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    registry = new RegistryService(db, bus)
    policy = new PolicyEngine(db, bus)
    risk = new RiskScorer(db, [])
    approval = {
      request: vi.fn(async (): Promise<ApprovalDecision> => ({ decision: 'allowed' })),
    }
    audit = new AuditLogger(db, bus)
    // Register the agents under test
    registry.register({ id: 'openclaw', displayName: 'OpenClaw', transport: 'stdio' })
    registry.register({ id: 'hermes', displayName: 'Hermes', transport: 'stdio' })
    registry.register({ id: 'reviewer', displayName: 'Reviewer', transport: 'stdio' })
    mediator = new MediatorService({ registry, policy, risk, approval, bus, db })
  })

  afterEach(() => {
    audit.dispose()
    sqlite.close()
  })

  function rowsByOrder(): SessionRow[] {
    // Audit logger batches writes — flush before reading.
    audit.flush()
    return sqlite
      .prepare(
        `SELECT id, source_agent, parent_request_id, session_id FROM requests ORDER BY created_at ASC, id ASC`,
      )
      .all() as SessionRow[]
  }

  function rowById(id: string): SessionRow {
    audit.flush()
    const row = sqlite
      .prepare(
        `SELECT id, source_agent, parent_request_id, session_id FROM requests WHERE id = ?`,
      )
      .get(id) as SessionRow | undefined
    if (!row) throw new Error(`no row for id ${id}`)
    return row
  }

  it('first-in-chain request persists with null parent + sessionId (when caller omits both)', async () => {
    await mediator.handleRequest({
      sourceAgent: 'openclaw',
      targetTool: 'noop',
      message: callMessage(1, 'noop', {}),
    })
    const rows = rowsByOrder()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.parent_request_id).toBeNull()
    expect(rows[0]!.session_id).toBeNull()
  })

  it('persists sessionId when the caller supplies one (root-of-chain case)', async () => {
    await mediator.handleRequest({
      sourceAgent: 'openclaw',
      targetTool: 'noop',
      sessionId: 'session-A',
      message: callMessage(1, 'noop', {}),
    })
    const rows = rowsByOrder()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.session_id).toBe('session-A')
    expect(rows[0]!.parent_request_id).toBeNull()
  })

  it('1-hop delegation: child row inherits sessionId + points parent at root', async () => {
    const root = await mediator.handleRequest({
      sourceAgent: 'openclaw',
      targetTool: 'plan',
      sessionId: 'session-B',
      message: callMessage(1, 'plan', {}),
    })
    const child = await mediator.handleRequest({
      sourceAgent: 'openclaw',
      targetAgent: 'hermes',
      targetTool: 'write_code',
      sessionId: 'session-B',
      parentRequestId: root.requestId,
      message: callMessage(2, 'write_code', {}),
    })
    expect(rowById(root.requestId).session_id).toBe('session-B')
    expect(rowById(root.requestId).parent_request_id).toBeNull()
    expect(rowById(child.requestId).session_id).toBe('session-B')
    expect(rowById(child.requestId).parent_request_id).toBe(root.requestId)
  })

  it('2-hop chain: every row shares sessionId, parent IDs form a tree', async () => {
    const root = await mediator.handleRequest({
      sourceAgent: 'openclaw',
      targetTool: 'plan',
      sessionId: 'session-C',
      message: callMessage(1, 'plan', {}),
    })
    const child = await mediator.handleRequest({
      sourceAgent: 'openclaw',
      targetAgent: 'hermes',
      targetTool: 'write_code',
      sessionId: 'session-C',
      parentRequestId: root.requestId,
      message: callMessage(2, 'write_code', {}),
    })
    const grandchild = await mediator.handleRequest({
      sourceAgent: 'hermes',
      targetAgent: 'reviewer',
      targetTool: 'review',
      sessionId: 'session-C',
      parentRequestId: child.requestId,
      message: callMessage(3, 'review', {}),
    })
    expect(rowById(root.requestId).session_id).toBe('session-C')
    expect(rowById(child.requestId).session_id).toBe('session-C')
    expect(rowById(grandchild.requestId).session_id).toBe('session-C')
    expect(rowById(root.requestId).parent_request_id).toBeNull()
    expect(rowById(child.requestId).parent_request_id).toBe(root.requestId)
    expect(rowById(grandchild.requestId).parent_request_id).toBe(child.requestId)
  })

  it('concurrent sessions do not cross-pollute', async () => {
    const rootA = await mediator.handleRequest({
      sourceAgent: 'openclaw',
      targetTool: 'plan',
      sessionId: 'session-A',
      message: callMessage(1, 'plan', {}),
    })
    const rootB = await mediator.handleRequest({
      sourceAgent: 'hermes',
      targetTool: 'plan',
      sessionId: 'session-B',
      message: callMessage(2, 'plan', {}),
    })
    await mediator.handleRequest({
      sourceAgent: 'openclaw',
      targetAgent: 'hermes',
      targetTool: 'write',
      sessionId: 'session-A',
      parentRequestId: rootA.requestId,
      message: callMessage(3, 'write', {}),
    })
    await mediator.handleRequest({
      sourceAgent: 'hermes',
      targetAgent: 'reviewer',
      targetTool: 'review',
      sessionId: 'session-B',
      parentRequestId: rootB.requestId,
      message: callMessage(4, 'review', {}),
    })
    audit.flush()
    const sessionA = sqlite
      .prepare(`SELECT * FROM requests WHERE session_id = 'session-A'`)
      .all() as SessionRow[]
    const sessionB = sqlite
      .prepare(`SELECT * FROM requests WHERE session_id = 'session-B'`)
      .all() as SessionRow[]
    expect(sessionA).toHaveLength(2)
    expect(sessionB).toHaveLength(2)
    // No cross-pollination — parent ids stay within their session
    for (const r of sessionA) {
      if (r.parent_request_id) {
        expect(sessionA.map((x) => x.id)).toContain(r.parent_request_id)
      }
    }
    for (const r of sessionB) {
      if (r.parent_request_id) {
        expect(sessionB.map((x) => x.id)).toContain(r.parent_request_id)
      }
    }
  })

  it('emits parentRequestId + sessionId on the request:decided event', async () => {
    const events: { parentRequestId?: string; sessionId?: string }[] = []
    bus.on('request:decided', (e) =>
      events.push({
        parentRequestId: e.parentRequestId,
        sessionId: e.sessionId,
      }),
    )
    await mediator.handleRequest({
      sourceAgent: 'openclaw',
      targetTool: 'plan',
      sessionId: 'session-D',
      parentRequestId: 'prev-root',
      message: callMessage(1, 'plan', {}),
    })
    expect(events).toHaveLength(1)
    expect(events[0]!.sessionId).toBe('session-D')
    expect(events[0]!.parentRequestId).toBe('prev-root')
  })
})
