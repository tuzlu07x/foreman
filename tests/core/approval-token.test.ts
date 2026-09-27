import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DbApprovalService } from '../../src/core/approval.js'
import {
  actionIdForDecision,
  approvalSigner,
  approvalTag,
  compactBlockActionId,
  deriveApprovalKey,
  parseApprovalToken,
  verifyApprovalTag,
} from '../../src/core/approval-token.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { pendingApprovals } from '../../src/db/schema.js'

describe('approval tokens', () => {
  const key = deriveApprovalKey(randomBytes(32))

  it('binds the tag to both the approval and the action', () => {
    const tag = approvalTag(key, 'req-1', 'allow')
    expect(verifyApprovalTag(key, 'req-1', 'allow', tag)).toBe(true)
    expect(verifyApprovalTag(key, 'req-1', 'allow_always', tag)).toBe(false)
    expect(verifyApprovalTag(key, 'req-2', 'allow', tag)).toBe(false)
    expect(verifyApprovalTag(key, 'req-1', 'allow', null)).toBe(false)
  })

  it('parses `<id>.<tag>` and bare ids', () => {
    expect(parseApprovalToken('01ABC.xyz')).toEqual({ approvalId: '01ABC', tag: 'xyz' })
    expect(parseApprovalToken('01ABC')).toEqual({ approvalId: '01ABC', tag: null })
  })

  it('maps decisions onto keyboard action ids', () => {
    expect(actionIdForDecision('allow', false)).toBe('allow')
    expect(actionIdForDecision('allow', true)).toBe('allow_always')
    expect(actionIdForDecision('deny', true)).toBe('deny_always')
    expect(actionIdForDecision('deny', false, 'block_secret_path')).toBe('block_secret_path')
  })
})

describe('relayed approvals (submit_approval) across processes', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  const masterKey = randomBytes(32)
  const key = deriveApprovalKey(masterKey)
  const sign = approvalSigner(masterKey)

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
  })
  afterEach(() => {
    sqlite.close()
  })

  function pendingRequest(requestId: string) {
    // Process A — the requester (an agent's mcp-stdio, the hook, wrap).
    const requester = new DbApprovalService(db, {
      bus: new EventBus<ForemanEventMap>(),
      timeoutMs: 2_000,
      pollIntervalMs: 10,
    })
    return requester.request({
      requestId,
      sourceAgent: 'hermes',
      targetTool: 'read_file',
      args: { path: '.env' },
      riskScore: 80,
      riskReasons: [],
      riskFactors: [],
      riskBucket: 'high',
      llmVerification: null,
      securityReport: null,
    })
  }

  // Process B — the chat agent's own mcp-stdio, with its own bus and no
  // ApprovalBridge. Before the fix the decision only reached B's bus, so A
  // timed out to deny while the agent had replied "Submitted".
  function relay() {
    return new DbApprovalService(db, { bus: new EventBus<ForemanEventMap>(), approvalKey: key })
  }

  async function waitForRow(requestId: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (db.select().from(pendingApprovals).all().some((r) => r.requestId === requestId)) return
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  it("delivers the user's tapped allow to the waiting requester", async () => {
    const waiting = pendingRequest('req-a')
    await waitForRow('req-a')
    const out = await relay().submitFromAgent({
      approvalId: `req-a.${sign('req-a', 'allow')}`,
      decision: 'allow',
      sourceAgent: 'hermes',
    })
    expect(out.ok).toBe(true)
    await expect(waiting).resolves.toMatchObject({ decision: 'allowed', via: 'agent_mcp' })
  })

  it('refuses an allow without the token (agent approving its own call)', async () => {
    const waiting = pendingRequest('req-b')
    await waitForRow('req-b')
    const out = await relay().submitFromAgent({ approvalId: 'req-b', decision: 'allow', sourceAgent: 'hermes' })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/approval token/)
    await expect(waiting).resolves.toMatchObject({ decision: 'denied' })
  })

  it('refuses to replay a Deny tap as an Allow', async () => {
    const waiting = pendingRequest('req-c')
    await waitForRow('req-c')
    const out = await relay().submitFromAgent({
      approvalId: `req-c.${sign('req-c', 'deny')}`,
      decision: 'allow',
      sourceAgent: 'hermes',
    })
    expect(out.ok).toBe(false)
    await expect(waiting).resolves.toMatchObject({ decision: 'denied' })
  })

  it('accepts a plain relayed deny without a token (refusing is always safe)', async () => {
    const waiting = pendingRequest('req-d')
    await waitForRow('req-d')
    const out = await relay().submitFromAgent({ approvalId: 'req-d', decision: 'deny', sourceAgent: 'hermes' })
    expect(out.ok).toBe(true)
    await expect(waiting).resolves.toMatchObject({ decision: 'denied' })
  })

  it('reports an approval that is no longer pending', async () => {
    const waiting = pendingRequest('req-e')
    await waitForRow('req-e')
    await relay().submitFromAgent({ approvalId: 'req-e', decision: 'deny', sourceAgent: 'hermes' })
    await waiting
    const again = await relay().submitFromAgent({
      approvalId: `req-e.${sign('req-e', 'allow')}`,
      decision: 'allow',
      sourceAgent: 'hermes',
    })
    expect(again.ok).toBe(false)
    expect(again.error).toMatch(/already resolved|no longer pending/)
  })

  it('a remembered deny changes policy, so it needs the token too', async () => {
    const waiting = pendingRequest('req-g')
    await waitForRow('req-g')
    const forged = await relay().submitFromAgent({
      approvalId: 'req-g',
      decision: 'deny',
      remember: true,
      sourceAgent: 'hermes',
    })
    expect(forged.ok).toBe(false)
    const tapped = await relay().submitFromAgent({
      approvalId: `req-g.${sign('req-g', 'deny_always')}`,
      decision: 'deny',
      remember: true,
      sourceAgent: 'hermes',
    })
    expect(tapped.ok).toBe(true)
    await expect(waiting).resolves.toMatchObject({ decision: 'denied' })
  })

  it('resolves a compact block_* id back to its risk factor', async () => {
    db.insert(pendingApprovals)
      .values({
        requestId: 'req-h',
        sourceAgent: 'hermes',
        targetAgent: null,
        targetTool: 'read_file',
        args: JSON.stringify({ path: '.env' }),
        riskScore: 80,
        riskReasons: JSON.stringify(['secret_path']),
        riskFactors: JSON.stringify([
          { rule: 'secret_path', category: 'secret', points: 60, reason: '.env-style file' },
        ]),
        riskBucket: 'high',
        status: 'pending',
        requestedAt: Date.now(),
      })
      .run()
    const injected: unknown[] = []
    const service = new DbApprovalService(db, {
      bus: new EventBus<ForemanEventMap>(),
      approvalKey: key,
      injectPredicateRule: (input) => {
        injected.push(input)
        return 9
      },
    })
    const compact = compactBlockActionId('block_secret_path')
    const out = await service.submitFromAgent({
      approvalId: `req-h.${sign('req-h', compact)}`,
      decision: 'deny',
      sourceAgent: 'hermes',
      actionId: compact,
    })
    expect(out.ok).toBe(true)
    expect(injected).toHaveLength(1)
  })

  it('cancelPending denies approvals whose caller disconnected', async () => {
    const waiting = pendingRequest('req-f')
    await waitForRow('req-f')
    relay().cancelPending(['req-f'])
    await expect(waiting).resolves.toMatchObject({ decision: 'denied' })
  })

  it('close() cancels waiting requests and refuses new ones without a row', async () => {
    const service = new DbApprovalService(db, {
      bus: new EventBus<ForemanEventMap>(),
      timeoutMs: 5_000,
      pollIntervalMs: 10,
    })
    const req = (requestId: string) =>
      service.request({
        requestId,
        sourceAgent: 'hermes',
        targetTool: 'read_file',
        args: { path: '.env' },
        riskScore: 80,
        riskReasons: [],
        riskFactors: [],
        riskBucket: 'high',
        llmVerification: null,
        securityReport: null,
      })
    const waiting = req('req-i')
    await waitForRow('req-i')
    service.close()
    await expect(waiting).resolves.toEqual({ decision: 'denied', cancelled: true })
    await expect(req('req-j')).resolves.toEqual({ decision: 'denied', cancelled: true })
    const rows = db.select().from(pendingApprovals).all()
    expect(rows.map((r) => r.requestId)).toEqual(['req-i'])
    expect(rows[0]!.status).toBe('resolved')
  })
})
