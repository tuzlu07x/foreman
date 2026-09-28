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

  it('denies every call from a blocked agent without scoring or asking', async () => {
    registry.register({ id: 'hermes', displayName: 'H', transport: 'stdio' })
    registry.block('hermes')
    const mediator = new MediatorService({ registry, policy, risk, approval, bus })
    const result = await mediator.handleRequest({
      sourceAgent: 'hermes',
      targetTool: 'list_files',
      message: callMessage(1, 'list_files', { path: '.' }),
    })
    expect(result.decision).toBe('denied')
    expect(result.decidedBy).toBe('agent:blocked')
    expect(approval.request).not.toHaveBeenCalled()
  })

  it.each([['QA-BOT'], ['Qa-Bot'], ['untrusted:QA-BOT'], ['untrusted:qa-bot']])(
    'a block on qa-bot holds for %s: ids are compared ignoring case (#656)',
    async (sourceAgent) => {
      registry.register({ id: 'qa-bot', displayName: 'Q', transport: 'stdio' })
      registry.block('qa-bot')
      const mediator = new MediatorService({ registry, policy, risk, approval, bus })
      const result = await mediator.handleRequest({
        sourceAgent,
        targetTool: 'list_files',
        message: callMessage(1, 'list_files', { path: '.' }),
      })
      expect(result.decidedBy).toBe('agent:blocked')
      expect(approval.request).not.toHaveBeenCalled()
    },
  )

  it('a pause holds whatever the case, and a block on any spelling wins (#656)', async () => {
    registry.register({ id: 'Codex', displayName: 'C', transport: 'stdio' })
    registry.disable('Codex')
    const mediator = new MediatorService({ registry, policy, risk, approval, bus })
    const paused = await mediator.handleRequest({
      sourceAgent: 'codex',
      targetTool: 'list_files',
      message: callMessage(1, 'list_files', { path: '.' }),
    })
    expect(paused.decidedBy).toBe('agent:disabled')
    registry.register({ id: 'CODEX', displayName: 'C2', transport: 'stdio' })
    registry.block('CODEX')
    const blocked = await mediator.handleRequest({
      sourceAgent: 'codex',
      targetTool: 'list_files',
      message: callMessage(2, 'list_files', { path: '.' }),
    })
    expect(blocked.decidedBy).toBe('agent:blocked')
  })

  describe('remembered answers cover the call, not the whole tool (#656)', () => {
    const call = (id: number, path: string) => ({
      sourceAgent: 'qa-bot',
      targetTool: 'read_file',
      message: callMessage(id, 'read_file', { path }),
    })

    it('"deny always" on one file denies that file only', async () => {
      const denyAlways = vi.fn(async (): Promise<ApprovalDecision> => ({ decision: 'denied', remember: 'deny', via: 'tui' }))
      const mediator = new MediatorService({ registry, policy, risk, approval: { request: denyAlways }, bus })
      await mediator.handleRequest(call(1, '/home/u/.ssh/id_rsa'))
      const again = await mediator.handleRequest(call(2, '/home/u/.ssh/id_rsa'))
      expect(again.decidedBy).toMatch(/^policy:\d+$/)
      const readme = await mediator.handleRequest(call(3, 'README.md'))
      expect(readme.decidedBy).not.toMatch(/^policy:/)
      expect(denyAlways).toHaveBeenCalledTimes(2)
    })

    it('"always allow" is scoped the same way', async () => {
      const allowAlways = vi.fn(async (): Promise<ApprovalDecision> => ({ decision: 'allowed', remember: 'allow', via: 'tui' }))
      policy.loadYamlText('rules:\n  - source: "*"\n    target: tool:read_file\n    effect: ask\n')
      const mediator = new MediatorService({ registry, policy, risk, approval: { request: allowAlways }, bus })
      await mediator.handleRequest(call(1, 'docs/a.md'))
      expect((await mediator.handleRequest(call(2, 'docs/a.md'))).decidedBy).toMatch(/^policy:\d+$/)
      await mediator.handleRequest(call(3, 'docs/b.md'))
      expect(allowAlways).toHaveBeenCalledTimes(2)
    })
  })

  describe('requireHuman (#656)', () => {
    const factor = { rule: 'relayed_command', category: 'structural' as const, points: 60, reason: 'relays /foreman stop' }

    it('asks even when policy allows and the score is low, and never remembers the answer', async () => {
      policy.remember({ sourceAgent: 'hermes', target: 'tool:foreman_command', effect: 'allow' })
      const allow = vi.fn(async (): Promise<ApprovalDecision> => ({ decision: 'allowed', remember: 'allow', via: 'tui' }))
      const mediator = new MediatorService({ registry, policy, risk, approval: { request: allow }, bus })
      const before = policy.list().length
      const result = await mediator.handleRequest({
        sourceAgent: 'hermes',
        targetTool: 'foreman_command',
        message: callMessage(1, 'foreman_command', { command: 'stop', args: [] }),
        requireHuman: { factor },
      })
      expect(allow).toHaveBeenCalledOnce()
      const asked = (allow.mock.calls[0] as unknown as [{ riskBucket: string; riskReasons: string[] }])[0]
      expect(asked.riskReasons).toContain('relayed_command')
      expect(asked.riskBucket).toBe('high')
      expect(result).toMatchObject({ decision: 'allowed', decidedBy: 'user:tui' })
      expect(policy.list()).toHaveLength(before)
    })

    it('a policy deny still wins without asking', async () => {
      policy.remember({ sourceAgent: 'hermes', target: 'tool:foreman_command', effect: 'deny' })
      const mediator = new MediatorService({ registry, policy, risk, approval, bus })
      const result = await mediator.handleRequest({
        sourceAgent: 'hermes',
        targetTool: 'foreman_command',
        message: callMessage(1, 'foreman_command', { command: 'stop', args: [] }),
        requireHuman: { factor },
      })
      expect(result.decision).toBe('denied')
      expect(result.decidedBy).toMatch(/^policy:/)
      expect(approval.request).not.toHaveBeenCalled()
    })
  })

  it('denies calls from a paused (disabled) agent', async () => {
    registry.register({ id: 'codex', displayName: 'C', transport: 'stdio' })
    registry.disable('codex')
    const mediator = new MediatorService({ registry, policy, risk, approval, bus })
    const result = await mediator.handleRequest({
      sourceAgent: 'codex',
      targetTool: 'list_files',
      message: callMessage(1, 'list_files', { path: '.' }),
    })
    expect(result.decidedBy).toBe('agent:disabled')
  })

  it('applies policyFallback only when policy.yaml has no matching rule', async () => {
    const mediator = new MediatorService({ registry, policy, risk, approval, bus })
    const allowed = await mediator.handleRequest({
      sourceAgent: 'hermes',
      targetTool: 'github__list_issues',
      message: callMessage(1, 'github__list_issues', {}),
      policyFallback: { effect: 'allow', source: 'mcp.yaml:github' },
    })
    expect(allowed.decision).toBe('allowed')
    expect(allowed.decidedBy).toBe('policy:mcp.yaml:github')
    expect(approval.request).not.toHaveBeenCalled()

    policy.loadYamlText(`
rules:
  - source: "*"
    target: "tool:github__list_issues"
    effect: deny
`)
    const overridden = await mediator.handleRequest({
      sourceAgent: 'hermes',
      targetTool: 'github__list_issues',
      message: callMessage(2, 'github__list_issues', {}),
      policyFallback: { effect: 'allow', source: 'mcp.yaml:github' },
    })
    expect(overridden.decision).toBe('denied')
    expect(overridden.decidedBy).toMatch(/^policy:\d+$/)
  })

  it('policyFallback deny refuses without asking; ask escalates to approval', async () => {
    const mediator = new MediatorService({ registry, policy, risk, approval, bus })
    const denied = await mediator.handleRequest({
      sourceAgent: 'hermes',
      targetTool: 'stripe__create_refund',
      message: callMessage(1, 'stripe__create_refund', {}),
      policyFallback: { effect: 'deny', source: 'mcp.yaml:stripe' },
    })
    expect(denied.decidedBy).toBe('policy:mcp.yaml:stripe')
    expect(approval.request).not.toHaveBeenCalled()
    await mediator.handleRequest({
      sourceAgent: 'hermes',
      targetTool: 'stripe__create_refund',
      message: callMessage(2, 'stripe__create_refund', {}),
      policyFallback: { effect: 'ask', source: 'mcp.yaml:stripe' },
    })
    expect(approval.request).toHaveBeenCalledTimes(1)
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
