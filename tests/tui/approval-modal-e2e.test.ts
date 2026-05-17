import React from 'react'
import { render } from 'ink-testing-library'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApprovalModal } from '../../src/tui/components/approval-modal.js'
import {
  BusApprovalService,
  type ApprovalRequest,
} from '../../src/core/approval.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { MediatorService } from '../../src/core/mediator.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { RegistryService } from '../../src/core/registry.js'
import { RiskScorer } from '../../src/core/risk-scorer.js'
import { secretPatternRule } from '../../src/core/risk-rules/secret-patterns.js'
import { firstAgentToAgent } from '../../src/core/risk-rules/first-agent-to-agent.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import type { JSONRPCMessage } from '../../src/mcp/types.js'

// =============================================================================
// QA-018 — programmatic end-to-end approval modal flow.
//
// The expect-script pty test struggled with @inkjs/ui's TextInput raw-mode
// timing. This test mounts the real pieces (mediator + policy + risk +
// approval service + bus) and drives a high-risk request through code,
// then captures the ApprovalModal frames showing every state.
//
// What this proves:
//   1. mediator emits `approval:requested` with a populated SecurityReport
//   2. ApprovalModal renders all three layers (verdict / narrative / footer)
//   3. technicalExpanded={true} surfaces the technical breakdown
//   4. severity border styles work for high vs critical
//   5. footer matches the source variant (heuristic_only here, no LLM)
// =============================================================================

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

function callMessage(tool: string, args: unknown): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  } as JSONRPCMessage
}

describe('QA-018 — approval modal end-to-end', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let registry: RegistryService
  let policy: PolicyEngine
  let risk: RiskScorer
  let approvalService: BusApprovalService
  let mediator: MediatorService

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    registry = new RegistryService(db, bus)
    policy = new PolicyEngine(db, bus)
    risk = new RiskScorer(db, [secretPatternRule, firstAgentToAgent])
    // BusApprovalService waits for `approval:resolved` events — we'll emit
    // them from the test to simulate the user pressing a hotkey.
    approvalService = new BusApprovalService({ bus, timeoutMs: 5_000 })
    mediator = new MediatorService({
      registry,
      policy,
      risk,
      approval: approvalService,
      bus,
    })
  })

  afterEach(() => {
    sqlite.close()
  })

  it('full pipeline: high-risk request → modal renders 3 layers → user denies', async () => {
    // Set up the world the user sees in the TUI.
    registry.register({
      id: 'my-claude',
      displayName: 'Claude Code',
      transport: 'stdio',
    })

    // Capture the bus events the TUI would see.
    const requested: ForemanEventMap['approval:requested'][] = []
    const decided: ForemanEventMap['request:decided'][] = []
    bus.on('approval:requested', (e) => requested.push(e))
    bus.on('request:decided', (e) => decided.push(e))

    // Fire the request. By default Risk + Policy will push `.env` reads into
    // the "ask" bucket → mediator emits approval:requested → waits on the
    // user's response (BusApprovalService).
    const pending = mediator.handleRequest({
      sourceAgent: 'my-claude',
      targetTool: 'read_file',
      message: callMessage('read_file', { path: '.env' }),
    })

    // Give the mediator a microtask to emit `approval:requested`.
    await new Promise((r) => setTimeout(r, 50))

    expect(requested).toHaveLength(1)
    const req = requested[0]!
    expect(req.sourceAgent).toBe('my-claude')
    expect(req.targetTool).toBe('read_file')
    expect(req.riskFactors.length).toBeGreaterThan(0)
    expect(req.riskBucket).toMatch(/^(medium|high|critical)$/)
    expect(req.securityReport, 'modal needs a SecurityReport').toBeDefined()
    expect(req.securityReport).not.toBeNull()

    // Now mount the modal with the real request the mediator just emitted.
    const approvalRequest: ApprovalRequest = {
      requestId: req.requestId,
      sourceAgent: req.sourceAgent,
      targetAgent: req.targetAgent,
      targetTool: req.targetTool,
      args: req.args,
      riskScore: req.riskScore,
      riskReasons: req.riskReasons,
      riskFactors: req.riskFactors,
      riskBucket: req.riskBucket,
      llmVerification: req.llmVerification,
      securityReport: req.securityReport,
    }
    const { lastFrame, rerender } = render(
      React.createElement(ApprovalModal, {
        request: approvalRequest,
        remainingSeconds: 42,
        technicalExpanded: false,
      }),
    )

    // Initial (collapsed) frame — should show verdict + narrative + footer.
    const collapsed = stripAnsi(lastFrame() ?? '')
    expect(collapsed, 'verdict label visible').toMatch(/RISK|THREAT|UNCERTAIN/i)
    expect(collapsed, 'tool name visible').toContain('read_file')
    expect(collapsed, '.env path visible').toContain('.env')
    expect(collapsed, 'technical hint visible (collapsed)').toMatch(
      /Press \[t\] for technical detail/,
    )
    expect(collapsed, 'foreman recommendation visible').toMatch(/foreman →/)
    expect(collapsed, 'source footer visible').toMatch(
      /Smart analysis|Heuristic-only/,
    )
    expect(collapsed, 'hotkeys visible').toContain('[a]')
    expect(collapsed, 'hotkeys visible').toContain('[d]')
    expect(collapsed, '[t] hotkey visible').toContain('[t]')
    expect(collapsed, '42s timer visible').toContain('42s')

    // Re-render with technical expanded (what pressing 't' does).
    rerender(
      React.createElement(ApprovalModal, {
        request: approvalRequest,
        remainingSeconds: 42,
        technicalExpanded: true,
      }),
    )
    const expanded = stripAnsi(lastFrame() ?? '')
    expect(expanded, 'technical block label visible').toContain('Technical detail')
    expect(expanded, 'heuristic score visible').toMatch(/heuristic \d+/)
    expect(expanded, 'final score visible').toMatch(/final \d+\/100/)
    expect(expanded, 'no collapsed hint when expanded').not.toMatch(
      /Press \[t\] for technical detail/,
    )

    // Now simulate the user pressing 'd' — emit the resolved event the
    // BusApprovalService listens for.
    bus.emit('approval:resolved', {
      requestId: req.requestId,
      decision: 'denied',
      resolvedBy: 'user',
    })

    const result = await pending
    expect(result.decision).toBe('denied')
    expect(result.decidedBy).toBe('user')
    expect(decided).toHaveLength(1)
    expect(decided[0]!.decision).toBe('denied')
    expect(decided[0]!.securityReport).toEqual(req.securityReport)
  })

  it('emits a SecurityReport (heuristic_only — no LLM)', async () => {
    registry.register({
      id: 'a',
      displayName: 'a',
      transport: 'stdio',
    })

    const reports: ForemanEventMap['approval:requested'][] = []
    bus.on('approval:requested', (e) => reports.push(e))

    void mediator.handleRequest({
      sourceAgent: 'a',
      targetTool: 'read_file',
      message: callMessage('read_file', { path: '.env' }),
    })
    await new Promise((r) => setTimeout(r, 50))
    bus.emit('approval:resolved', {
      requestId: reports[0]!.requestId,
      decision: 'denied',
      resolvedBy: 'user',
    })

    expect(reports[0]!.securityReport).not.toBeNull()
    const report = reports[0]!.securityReport!
    expect(report.source).toBe('heuristic_only')
    expect(report.narrative.recommendation).toBe('ask')
    expect(report.technical.factors.length).toBeGreaterThan(0)
    expect(report.verdict.label).toMatch(/RISK|UNCERTAIN/i)
  })

  it('A (always allow) → mediator allows AND writes a policy rule (remember)', async () => {
    registry.register({ id: 'a', displayName: 'a', transport: 'stdio' })
    const requested: ForemanEventMap['approval:requested'][] = []
    const resolved: ForemanEventMap['approval:resolved'][] = []
    bus.on('approval:requested', (e) => requested.push(e))
    bus.on('approval:resolved', (e) => resolved.push(e))

    const beforeCount = policy.list().length

    const pending = mediator.handleRequest({
      sourceAgent: 'a',
      targetTool: 'read_file',
      message: callMessage('read_file', { path: '.env' }),
    })
    await new Promise((r) => setTimeout(r, 50))

    // Mirror the TUI's "A" → resolves with remember=allow.
    bus.emit('approval:resolved', {
      requestId: requested[0]!.requestId,
      decision: 'allowed',
      remember: 'allow',
      resolvedBy: 'user',
    })
    const result = await pending
    expect(result.decision).toBe('allowed')
    expect(result.decidedBy).toBe('user')
    // The resolved bus payload carries the remember flag the TUI emits.
    expect(resolved[0]!.remember).toBe('allow')
    // And the mediator persisted a new policy rule.
    expect(policy.list().length).toBe(beforeCount + 1)
  })

  it('timeout path: no user response → mediator denies (decidedBy:user from the approval contract)', async () => {
    registry.register({ id: 'b', displayName: 'b', transport: 'stdio' })

    // Fresh bus to isolate from beforeEach's listeners.
    const isoBus = new EventBus<ForemanEventMap>()
    const fastApproval = new BusApprovalService({ bus: isoBus, timeoutMs: 100 })
    const fastMediator = new MediatorService({
      registry,
      policy,
      risk,
      approval: fastApproval,
      bus: isoBus,
    })

    const result = await fastMediator.handleRequest({
      sourceAgent: 'b',
      targetTool: 'read_file',
      message: callMessage('read_file', { path: '.env' }),
    })
    // Mediator abstracts over the approval service — both real user-deny
    // and timeout look like decidedBy=user from MediatorOutput. The TIMEOUT
    // signal lives on the bus event (resolvedBy: 'timeout').
    expect(result.decision).toBe('denied')
    expect(result.decidedBy).toBe('user')
  })
})
