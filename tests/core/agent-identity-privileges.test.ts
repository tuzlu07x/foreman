import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalDecision, ApprovalService } from '../../src/core/approval.js'
import { issueAgentToken, resolveAgentIdentity } from '../../src/core/agent-token.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { scopeForAgent } from '../../src/core/mcp-hub/boot.js'
import { MediatorService } from '../../src/core/mediator.js'
import { OrgComms } from '../../src/core/org/comms.js'
import { orgDelegationVerdict } from '../../src/core/org/guard.js'
import { allowedMcpServers, checkDelegation, parseOrgText, rolesForAgent } from '../../src/core/org/org.js'
import { findOrgTemplate } from '../../src/core/org/templates.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { RegistryService } from '../../src/core/registry.js'
import { RiskScorer } from '../../src/core/risk-scorer.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { generateMasterKey } from '../../src/identity/encryption.js'
import type { JSONRPCMessage } from '../../src/mcp/types.js'

// #618 acceptance: an MCP connection that claims another agent's id without
// that agent's token must not get the agent's allow rules, org role, hub
// servers or delegation rights — and must not escape the agent's block.

function call(tool: string, args: unknown = {}): JSONRPCMessage {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } } as JSONRPCMessage
}

describe('a spoofed --source without a token', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let registry: RegistryService
  let policy: PolicyEngine
  let store: SecretStore
  let approval: ApprovalService
  let dir: string
  let orgPath: string

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    registry = new RegistryService(db, bus)
    policy = new PolicyEngine(db, bus)
    store = new SecretStore(db, generateMasterKey())
    approval = { request: vi.fn(async (): Promise<ApprovalDecision> => ({ decision: 'denied' })) }
    registry.register({ id: 'codex', displayName: 'Codex', transport: 'stdio' })
    issueAgentToken(store, 'codex')
    dir = mkdtempSync(join(tmpdir(), 'foreman-identity-'))
    orgPath = join(dir, 'org.yaml')
    writeFileSync(orgPath, findOrgTemplate('startup')!.render('Acme'))
  })
  afterEach(() => {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const spoofed = (): string => resolveAgentIdentity({ claimed: 'codex', store }).source
  const mediator = (): MediatorService =>
    new MediatorService({ registry, policy, risk: new RiskScorer(db, []), approval, bus })

  it("doesn't get the agent's allow rules", async () => {
    policy.loadYamlText(`
rules:
  - source: codex
    target: "tool:deploy"
    effect: allow
`)
    const real = await mediator().handleRequest({ sourceAgent: 'codex', targetTool: 'deploy', message: call('deploy') })
    expect(real.decision).toBe('allowed')
    const fake = await mediator().handleRequest({ sourceAgent: spoofed(), targetTool: 'deploy', message: call('deploy') })
    expect(fake.decision).toBe('denied')
    expect(fake.decidedBy).not.toMatch(/^policy:/)
    expect(approval.request).toHaveBeenCalledOnce() // it had to ask, and was refused
  })

  it("still gets the agent's deny rules and wildcard rules like any unknown agent", async () => {
    policy.loadYamlText(`
rules:
  - source: "*"
    target: "tool:status"
    effect: allow
`)
    const out = await mediator().handleRequest({ sourceAgent: spoofed(), targetTool: 'status', message: call('status') })
    expect(out.decision).toBe('allowed')
  })

  it("stays bound by the agent's deny and ask rules, even where a wildcard allows", () => {
    policy.loadYamlText(`
rules:
  - source: "*"
    target: "tool:deploy"
    effect: allow
  - source: codex
    target: "tool:deploy"
    effect: deny
  - source: "*"
    target: "tool:push"
    effect: allow
  - source: codex
    target: "tool:push"
    effect: ask
  - source: codex
    target: "tool:status"
    effect: allow
`)
    expect(policy.evaluate({ sourceAgent: 'codex', targetTool: 'deploy' }).decision).toBe('deny')
    expect(policy.evaluate({ sourceAgent: spoofed(), targetTool: 'deploy' }).decision).toBe('deny')
    expect(policy.evaluate({ sourceAgent: spoofed(), targetTool: 'push' }).decision).toBe('ask')
    expect(policy.evaluate({ sourceAgent: 'codex', targetTool: 'status' }).decision).toBe('allow')
    expect(policy.evaluate({ sourceAgent: spoofed(), targetTool: 'status' }).decision).toBe('ask')
    // Another agent's rules don't leak onto it either way.
    expect(policy.evaluate({ sourceAgent: 'untrusted:hermes', targetTool: 'deploy' }).decision).toBe('allow')
  })

  it("stays bound by the agent's secret denials", () => {
    policy.loadYamlText(`
rules:
  - source: "*"
    target: "secret:github-pat"
    effect: allow
agents:
  codex:
    cannot_access_secrets: [github-pat]
`)
    expect(policy.evaluateSecretAccess('untrusted:hermes', 'github-pat').decision).toBe('allow')
    expect(policy.evaluateSecretAccess(spoofed(), 'github-pat').decision).toBe('deny')
  })

  it("can't read the agent's secrets", async () => {
    store.add('github-pat', 'ghp_not_real')
    policy.loadYamlText(`
agents:
  codex:
    can_access_secrets: [github-pat]
`)
    const m = new MediatorService({ registry, policy, risk: new RiskScorer(db, []), approval, bus, secretStore: store })
    expect((await m.handleSecretGet({ sourceAgent: 'codex', secretName: 'github-pat' })).decision).toBe('allowed')
    expect((await m.handleSecretGet({ sourceAgent: spoofed(), secretName: 'github-pat' })).decision).toBe('denied')
  })

  it("stays blocked when the agent is blocked or paused", async () => {
    policy.loadYamlText(`
rules:
  - source: "*"
    target: "tool:status"
    effect: allow
`)
    registry.block('codex')
    const blocked = await mediator().handleRequest({ sourceAgent: spoofed(), targetTool: 'status', message: call('status') })
    expect(blocked).toMatchObject({ decision: 'denied', decidedBy: 'agent:blocked' })
    registry.unblock('codex')
    registry.disable('codex')
    const paused = await mediator().handleRequest({ sourceAgent: spoofed(), targetTool: 'status', message: call('status') })
    expect(paused).toMatchObject({ decision: 'denied', decidedBy: 'agent:disabled' })
  })

  it('"Always allow" on an unverified call is not remembered; "always deny" is', async () => {
    const remember = vi.spyOn(policy, 'remember')
    approval.request = vi.fn(async (): Promise<ApprovalDecision> => ({ decision: 'allowed', remember: 'allow' }))
    const out = await mediator().handleRequest({ sourceAgent: spoofed(), targetTool: 'deploy', message: call('deploy') })
    expect(out.decision).toBe('allowed')
    expect(remember).not.toHaveBeenCalled()
    approval.request = vi.fn(async (): Promise<ApprovalDecision> => ({ decision: 'denied', remember: 'deny' }))
    await mediator().handleRequest({ sourceAgent: spoofed(), targetTool: 'deploy', message: call('deploy') })
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ sourceAgent: 'untrusted:codex', effect: 'deny' }))
  })

  it("doesn't hold the agent's org role", () => {
    const org = parseOrgText(findOrgTemplate('startup')!.render('Acme'))
    expect(rolesForAgent(org, 'codex')).toEqual(['engineer'])
    expect(rolesForAgent(org, spoofed())).toEqual([])
    expect(checkDelegation(org, 'codex', 'claude-code')).toMatchObject({ allowed: true })
    expect(checkDelegation(org, spoofed(), 'claude-code')).toMatchObject({ allowed: false })
  })

  it("can't delegate, with or without an org chart", () => {
    expect(orgDelegationVerdict(orgPath, spoofed(), 'claude-code')).toMatchObject({ allowed: false })
    expect(orgDelegationVerdict(join(dir, 'missing.yaml'), spoofed(), 'claude-code')).toMatchObject({ allowed: false })
    // Outside the chart, a verified agent keeps its pre-org freedom.
    expect(orgDelegationVerdict(join(dir, 'missing.yaml'), 'codex', 'claude-code')).toBeNull()
  })

  it('gets no MCP hub servers, where the real agent gets its department’s', () => {
    const org = parseOrgText(findOrgTemplate('startup')!.render('Acme'))
    expect([...(allowedMcpServers(org, 'codex') ?? [])]).toContain('github')
    expect(allowedMcpServers(org, spoofed())?.size).toBe(0)
    expect(scopeForAgent(orgPath, spoofed()).allowedServers?.size).toBe(0)
    expect(scopeForAgent(join(dir, 'missing.yaml'), spoofed()).allowedServers?.size).toBe(0)
    expect(scopeForAgent(join(dir, 'missing.yaml'), 'codex').allowedServers).toBeNull()
  })

  it("can't post in the agent's department channel or read it", () => {
    const comms = new OrgComms(db, { orgConfigPath: orgPath })
    expect(comms.post({ from: 'codex', to: 'engineering', text: 'tests are green' }).ok).toBe(true)
    const fake = comms.post({ from: spoofed(), to: 'engineering', text: 'ship it' })
    expect(fake).toMatchObject({ ok: false })
    expect(comms.read({ viewer: spoofed() })).toEqual([])
  })
})
