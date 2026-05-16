import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalDecision, ApprovalService } from '../../src/core/approval.js'
import { AuditLogger } from '../../src/core/audit.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { MediatorService } from '../../src/core/mediator.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { RegistryService } from '../../src/core/registry.js'
import { RiskScorer } from '../../src/core/risk-scorer.js'
import { SessionManager } from '../../src/core/session.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { requests } from '../../src/db/schema.js'
import { sign } from '../../src/identity/signing.js'
import { MCPGateway } from '../../src/mcp/gateway.js'
import type { JSONRPCMessage } from '../../src/mcp/types.js'

const FAKE_CHILD = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../mcp/fixtures/fake-mcp-child.mjs',
)

function callMessage(id: number, tool: string, args: unknown): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  } as JSONRPCMessage
}

describe('MediatorService — unit', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let registry: RegistryService
  let policy: PolicyEngine
  let risk: RiskScorer
  let approval: ApprovalService

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    registry = new RegistryService(db, bus)
    policy = new PolicyEngine(db, bus)
    risk = new RiskScorer(db, [])
    approval = {
      request: vi.fn(async (): Promise<ApprovalDecision> => ({ decision: 'denied' })),
    }
  })

  afterEach(() => {
    sqlite.close()
  })

  it('rejects when authenticate fails (bad signature)', async () => {
    registry.register({ id: 'hermes', displayName: 'H', transport: 'stdio' })
    const mediator = new MediatorService({ registry, policy, risk, approval, bus })
    const result = await mediator.handleRequest({
      sourceAgent: 'hermes',
      targetTool: 'read_file',
      message: callMessage(1, 'read_file', { path: 'x.ts' }),
      signedPayload: 'msg',
      signature: Buffer.alloc(64),
    })
    expect(result.decision).toBe('denied')
    expect(result.decidedBy).toBe('auth-failure')
    expect(approval.request).not.toHaveBeenCalled()
  })

  it('short-circuits on policy deny without asking for approval', async () => {
    policy.loadYamlText(`
agents:
  hermes:
    cannot_call:
      claude-code: [read_file]
`)
    const mediator = new MediatorService({ registry, policy, risk, approval, bus })
    const result = await mediator.handleRequest({
      sourceAgent: 'hermes',
      targetAgent: 'claude-code',
      targetTool: 'read_file',
      message: callMessage(1, 'read_file', { path: 'x.ts' }),
    })
    expect(result.decision).toBe('denied')
    expect(result.decidedBy).toMatch(/^policy:/)
    expect(approval.request).not.toHaveBeenCalled()
  })

  it('policy allow + low risk → auto-allowed without approval', async () => {
    policy.loadYamlText(`
agents:
  hermes:
    can_call:
      claude-code: [read_file]
`)
    const mediator = new MediatorService({ registry, policy, risk, approval, bus })
    const result = await mediator.handleRequest({
      sourceAgent: 'hermes',
      targetAgent: 'claude-code',
      targetTool: 'read_file',
      message: callMessage(1, 'read_file', { path: 'src/auth.ts' }),
    })
    expect(result.decision).toBe('allowed')
    expect(result.decidedBy).toMatch(/^policy:/)
    expect(approval.request).not.toHaveBeenCalled()
  })

  it('policy ask → emits approval:requested and consults approval service', async () => {
    approval.request = vi.fn(
      async (): Promise<ApprovalDecision> => ({ decision: 'allowed' }),
    )
    const askEvents = vi.fn()
    bus.on('approval:requested', askEvents)

    const mediator = new MediatorService({ registry, policy, risk, approval, bus })
    const result = await mediator.handleRequest({
      sourceAgent: 'hermes',
      targetAgent: 'claude-code',
      targetTool: 'read_file',
      message: callMessage(1, 'read_file', { path: 'x.ts' }),
    })
    expect(askEvents).toHaveBeenCalledOnce()
    expect(approval.request).toHaveBeenCalledOnce()
    expect(result.decision).toBe('allowed')
    expect(result.decidedBy).toBe('user')
  })

  it('policy allow + high risk → still asks approval (threshold)', async () => {
    policy.loadYamlText(`
agents:
  hermes:
    can_call:
      claude-code: [read_file]
`)
    const highRisk = new RiskScorer(db, [
      {
        name: 'fake',
        category: 'structural',
        evaluate: () => [
          {
            rule: 'fake',
            category: 'structural',
            points: 60,
            reason: 'test',
          },
        ],
      },
    ])
    approval.request = vi.fn(
      async (): Promise<ApprovalDecision> => ({ decision: 'denied' }),
    )
    const mediator = new MediatorService({
      registry,
      policy,
      risk: highRisk,
      approval,
      bus,
    })
    const result = await mediator.handleRequest({
      sourceAgent: 'hermes',
      targetAgent: 'claude-code',
      targetTool: 'read_file',
      message: callMessage(1, 'read_file', { path: 'x.ts' }),
    })
    expect(approval.request).toHaveBeenCalledOnce()
    expect(result.decision).toBe('denied')
    expect(result.riskScore).toBe(60)
  })

  it('approval with remember triggers policy.remember()', async () => {
    approval.request = vi.fn(
      async (): Promise<ApprovalDecision> => ({
        decision: 'denied',
        remember: 'deny',
      }),
    )
    const rememberSpy = vi.spyOn(policy, 'remember')
    const mediator = new MediatorService({ registry, policy, risk, approval, bus })
    await mediator.handleRequest({
      sourceAgent: 'hermes',
      targetAgent: 'claude-code',
      targetTool: 'write_file',
      message: callMessage(1, 'write_file', { path: 'x.ts' }),
    })
    expect(rememberSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAgent: 'hermes',
        target: 'claude-code:write_file',
        effect: 'deny',
      }),
    )
  })

  it('always emits request:decided exactly once per call', async () => {
    const handler = vi.fn()
    bus.on('request:decided', handler)
    approval.request = vi.fn(
      async (): Promise<ApprovalDecision> => ({ decision: 'denied' }),
    )
    const mediator = new MediatorService({ registry, policy, risk, approval, bus })
    await mediator.handleRequest({
      sourceAgent: 'hermes',
      targetAgent: 'claude-code',
      targetTool: 'read_file',
      message: callMessage(1, 'read_file', { path: '.env' }),
    })
    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      decision: 'denied',
      durationMs: expect.any(Number),
    })
  })

  it('uses caller-provided requestId when given', async () => {
    const mediator = new MediatorService({ registry, policy, risk, approval, bus })
    approval.request = vi.fn(
      async (): Promise<ApprovalDecision> => ({ decision: 'denied' }),
    )
    const result = await mediator.handleRequest({
      requestId: 'my-custom-id',
      sourceAgent: 'hermes',
      targetAgent: 'claude-code',
      targetTool: 'read_file',
      message: callMessage(1, 'read_file', { path: 'x.ts' }),
    })
    expect(result.requestId).toBe('my-custom-id')
  })
})

describe('MediatorService — session halt', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let mediator: MediatorService
  let sessionManager: SessionManager

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    const registry = new RegistryService(db, bus)
    const policy = new PolicyEngine(db, bus)
    policy.loadYamlText(`
agents:
  agent-a:
    can_call:
      agent-b: [echo]
`)
    const risk = new RiskScorer(db, [])
    const approval: ApprovalService = {
      request: vi.fn(
        async (): Promise<ApprovalDecision> => ({ decision: 'denied' }),
      ),
    }
    sessionManager = new SessionManager(db, { bus })
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
    sqlite.close()
  })

  it('halts on the 6th turn — first 5 allowed, 6th denied with session:turn_limit', async () => {
    const haltHandler = vi.fn()
    bus.on('session:halted', haltHandler)
    const sessionId = sessionManager.startSession(['agent-a', 'agent-b'])

    for (let i = 1; i <= 5; i++) {
      const result = await mediator.handleRequest({
        sourceAgent: 'agent-a',
        targetAgent: 'agent-b',
        targetTool: 'echo',
        message: callMessage(i, 'echo', { text: `turn ${i}` }),
        sessionId,
      })
      expect(result.decision).toBe('allowed')
    }
    const sixth = await mediator.handleRequest({
      sourceAgent: 'agent-a',
      targetAgent: 'agent-b',
      targetTool: 'echo',
      message: callMessage(6, 'echo', { text: 'turn 6' }),
      sessionId,
    })
    expect(sixth.decision).toBe('denied')
    expect(sixth.decidedBy).toBe('session:turn_limit')
    expect(haltHandler).toHaveBeenCalledOnce()
    expect(sessionManager.isHalted(sessionId)).toBe(true)
  })

  it('blocks new calls on a session already halted', async () => {
    const sessionId = sessionManager.startSession(['agent-a', 'agent-b'])
    sessionManager.halt(sessionId)
    const result = await mediator.handleRequest({
      sourceAgent: 'agent-a',
      targetAgent: 'agent-b',
      targetTool: 'echo',
      message: callMessage(1, 'echo', { text: 'x' }),
      sessionId,
    })
    expect(result.decision).toBe('denied')
    expect(result.decidedBy).toBe('session:halted')
  })
})

describe('MediatorService — e2e through fake stdio child', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let gateway: MCPGateway
  let audit: AuditLogger

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    gateway = new MCPGateway(bus)
    audit = new AuditLogger(db, bus)
  })

  afterEach(() => {
    audit.dispose()
    gateway.dispose()
    sqlite.close()
  })

  it('forwards an allowed agent → agent call, returns the response, writes one requests row', async () => {
    const registry = new RegistryService(db, bus)
    const policy = new PolicyEngine(db, bus)
    const risk = new RiskScorer(db, [])
    const approval: ApprovalService = {
      request: vi.fn(async (): Promise<ApprovalDecision> => ({ decision: 'denied' })),
    }

    const { privateKey } = registry.register({
      id: 'agent-a',
      displayName: 'A',
      transport: 'stdio',
    })
    registry.register({ id: 'agent-b', displayName: 'B', transport: 'stdio' })

    policy.loadYamlText(`
agents:
  agent-a:
    can_call:
      agent-b: [echo]
`)

    gateway.attach('agent-b', {
      command: process.execPath,
      args: [FAKE_CHILD],
    })

    const mediator = new MediatorService({
      registry,
      policy,
      risk,
      approval,
      gateway,
      bus,
    })

    const payload = 'mediate-r1'
    const result = await mediator.handleRequest({
      sourceAgent: 'agent-a',
      targetAgent: 'agent-b',
      targetTool: 'echo',
      message: callMessage(99, 'echo', { text: 'hello kanka' }),
      signedPayload: payload,
      signature: sign(payload, privateKey!),
    })

    expect(result.decision).toBe('allowed')
    expect(approval.request).not.toHaveBeenCalled()
    const echoResult = result.result as {
      content: { type: string; text: string }[]
    }
    expect(echoResult.content[0]?.text).toBe('hello kanka')

    audit.flush()
    const rows = db.select().from(requests).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.sourceAgent).toBe('agent-a')
    expect(rows[0]?.targetAgent).toBe('agent-b')
    expect(rows[0]?.decision).toBe('allowed')
  })
})
