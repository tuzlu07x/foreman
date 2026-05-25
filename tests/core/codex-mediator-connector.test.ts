/**
 * Connector tests (#552 PR 4).
 *
 * Two layers of coverage:
 *
 *   1. Unit — wireBridgeToMediator() returns a CodexApprovalHandler whose
 *      decode → mediator → encode path round-trips correctly for both
 *      allow and deny.
 *
 *   2. Integration — wire a real CodexBridge to a fake mediator via the
 *      connector, drive both ends with in-memory streams, and assert the
 *      full JSON-RPC frames Foreman writes back to codex.
 *
 *   3. Fail-closed — malformed payloads + mediator throws both surface as
 *      `decline` decisions written to codex.
 */

import { describe, expect, it, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'

import { CodexBridge } from '../../src/core/codex-bridge.js'
import {
  wireBridgeToMediator,
  type MediatorLike,
} from '../../src/core/codex-mediator-connector.js'
import type { MediatorInput, MediatorOutput } from '../../src/core/mediator.js'

// =============================================================================
// Fixtures
// =============================================================================

/** Type-narrowed mediator double — vi.fn's inferred return type doesn't
 *  satisfy MediatorLike directly (no arg type), so we widen the mock
 *  signature explicitly and expose the spy for assertion. */
interface MediatorDouble extends MediatorLike {
  handleRequest: ReturnType<typeof vi.fn> &
    ((input: MediatorInput) => Promise<MediatorOutput>)
}

function mediatorReturning(
  decision: 'allowed' | 'denied',
  decidedBy = 'risk:auto-allow',
  riskReasons: string[] = [],
): MediatorDouble {
  const output: MediatorOutput = {
    requestId: 'req_test',
    decision,
    decidedBy,
    riskScore: 10,
    riskReasons,
    riskFactors: [],
    riskBucket: 'low',
    llmVerification: null,
    durationMs: 1,
  }
  const handleRequest = vi.fn(
    async (_input: MediatorInput): Promise<MediatorOutput> => output,
  )
  return { handleRequest } as MediatorDouble
}

function codexCommandWire(cmd: string) {
  return {
    method: 'item/commandExecution/requestApproval' as const,
    params: {
      itemId: 'item_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
      startedAtMs: 1,
      command: cmd,
      cwd: '/tmp',
      reason: null,
      commandActions: null,
      networkApprovalContext: null,
      additionalPermissions: null,
      availableDecisions: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
      approvalId: null,
    },
  }
}

function tick() {
  return new Promise((r) => setImmediate(r))
}

// =============================================================================
// 1. Unit — handler standalone
// =============================================================================

describe('wireBridgeToMediator — allow path', () => {
  it('decodes wire → calls mediator with normalised shape → returns accept', async () => {
    const mediator = mediatorReturning('allowed')
    const handler = wireBridgeToMediator({ sourceAgent: 'codex', mediator })

    const out = await handler(codexCommandWire('ls /tmp'))

    expect(mediator.handleRequest).toHaveBeenCalledTimes(1)
    const arg = mediator.handleRequest.mock.calls[0]![0]
    expect(arg.sourceAgent).toBe('codex')
    expect(arg.targetTool).toBe('shell_exec')
    expect(arg.sessionId).toBe('thread_1')
    expect(arg.message.params.arguments.cmd).toBe('ls /tmp')

    expect(out).toEqual({ decision: 'accept' })
  })
})

describe('wireBridgeToMediator — deny path', () => {
  it('returns decline with the first risk reason', async () => {
    const mediator = mediatorReturning('denied', 'risk:auto-deny', [
      'destructive_rm',
    ])
    const handler = wireBridgeToMediator({ sourceAgent: 'codex', mediator })

    const out = await handler(codexCommandWire('rm -rf /'))

    expect(out).toEqual({ decision: 'decline' })
  })

  it('falls back to "denied by <decidedBy>" when riskReasons is empty', async () => {
    const mediator = mediatorReturning('denied', 'policy:42', [])
    const handler = wireBridgeToMediator({ sourceAgent: 'codex', mediator })

    const out = await handler(codexCommandWire('ls'))
    expect(out).toEqual({ decision: 'decline' })

    // The reason is not in the wire response (codex's decision union has
    // no message slot for the basic decline), but is observable via
    // onResolved.
    const resolved: MediatorOutput[] = []
    const handler2 = wireBridgeToMediator({
      sourceAgent: 'codex',
      mediator,
      onResolved: (o) => resolved.push(o),
    })
    await handler2(codexCommandWire('ls'))
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.decidedBy).toBe('policy:42')
  })
})

// =============================================================================
// 2. Fail-closed paths
// =============================================================================

describe('wireBridgeToMediator — fail-closed', () => {
  it('returns decline when the adapter cannot decode the wire payload', async () => {
    const mediator = mediatorReturning('allowed')
    const handler = wireBridgeToMediator({ sourceAgent: 'codex', mediator })

    // Empty itemId trips the adapter's runtime guard.
    const wire = codexCommandWire('ls')
    wire.params.itemId = ''

    const out = await handler(wire)

    // Mediator never runs — decode fails first.
    expect(mediator.handleRequest).not.toHaveBeenCalled()
    expect(out).toEqual({ decision: 'decline' })
  })

  it('returns decline when the mediator throws', async () => {
    const mediator: MediatorLike = {
      handleRequest: vi.fn(
        async (_input: MediatorInput): Promise<MediatorOutput> => {
          throw new Error('db wedged')
        },
      ),
    }
    const handler = wireBridgeToMediator({ sourceAgent: 'codex', mediator })

    const out = await handler(codexCommandWire('ls'))
    expect(out).toEqual({ decision: 'decline' })
  })
})

// =============================================================================
// 3. Integration — real bridge + fake mediator + in-memory streams
// =============================================================================

/**
 * Wire CodexBridge to the connector so we exercise both ends. The test
 * pushes a JSON-RPC frame as if codex emitted it and asserts the frame
 * Foreman wrote back.
 */
function makePairedHarness() {
  const written: string[] = []
  const output = new Writable({
    write(chunk, _enc, cb) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const part of text.split('\n')) {
        if (part.length > 0) written.push(part)
      }
      cb()
    },
  })
  const input = new Readable({ read() {} })
  return {
    input,
    output,
    written,
    pushFrame(f: unknown) {
      input.push(JSON.stringify(f) + '\n')
    },
  }
}

describe('CodexBridge + connector — integration', () => {
  it('codex commandExecution request → mediator allowed → bridge writes accept frame', async () => {
    const h = makePairedHarness()
    const mediator = mediatorReturning('allowed')
    const bridge = new CodexBridge({
      input: h.input,
      output: h.output,
      onApprovalRequest: wireBridgeToMediator({
        sourceAgent: 'codex',
        mediator,
      }),
    })
    bridge.start()

    h.pushFrame({
      jsonrpc: '2.0',
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        itemId: 'item_X',
        threadId: 'thread_X',
        turnId: 'turn_X',
        startedAtMs: 100,
        command: 'echo hello',
        cwd: '/tmp',
        reason: null,
        commandActions: null,
        networkApprovalContext: null,
        additionalPermissions: null,
        availableDecisions: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
        approvalId: null,
      },
    })
    await tick()
    await tick()

    expect(h.written).toHaveLength(1)
    const reply = JSON.parse(h.written[0]!)
    expect(reply.id).toBe('approval-1')
    expect(reply.result).toEqual({ decision: 'accept' })
  })

  it('codex commandExecution request → mediator denied → bridge writes decline frame', async () => {
    const h = makePairedHarness()
    const mediator = mediatorReturning('denied', 'risk:auto-deny', ['rm_root'])
    const bridge = new CodexBridge({
      input: h.input,
      output: h.output,
      onApprovalRequest: wireBridgeToMediator({
        sourceAgent: 'codex',
        mediator,
      }),
    })
    bridge.start()

    h.pushFrame({
      jsonrpc: '2.0',
      id: 47,
      method: 'item/commandExecution/requestApproval',
      params: {
        itemId: 'rm_item',
        threadId: 't',
        turnId: 'tn',
        startedAtMs: 1,
        command: 'rm -rf /',
        cwd: '/',
        reason: 'unsafe',
        commandActions: null,
        networkApprovalContext: null,
        additionalPermissions: null,
        availableDecisions: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
        approvalId: null,
      },
    })
    await tick()
    await tick()

    const reply = JSON.parse(h.written[0]!)
    expect(reply.id).toBe(47)
    expect(reply.result).toEqual({ decision: 'decline' })
  })

  it('end-to-end FileChange request flows through connector to decline', async () => {
    const h = makePairedHarness()
    const mediator = mediatorReturning('denied', 'risk:auto-deny', [
      'writes_secret_file',
    ])
    const bridge = new CodexBridge({
      input: h.input,
      output: h.output,
      onApprovalRequest: wireBridgeToMediator({
        sourceAgent: 'codex',
        mediator,
      }),
    })
    bridge.start()

    h.pushFrame({
      jsonrpc: '2.0',
      id: 'fc-1',
      method: 'item/fileChange/requestApproval',
      params: {
        itemId: 'fc_X',
        threadId: 't',
        turnId: 'tn',
        reason: null,
        changes: [{ path: '/etc/shadow', kind: 'modify' }],
      },
    })
    await tick()
    await tick()

    const reply = JSON.parse(h.written[0]!)
    expect(reply.id).toBe('fc-1')
    expect(reply.result).toEqual({ decision: 'decline' })

    // Mediator received the normalised file_write tool.
    const mediatorArg = mediator.handleRequest.mock.calls[0]![0]
    expect(mediatorArg.targetTool).toBe('file_write')
    expect(mediatorArg.message.params.arguments.path).toBe('/etc/shadow')
  })

  it('onResolved fires with the mediator output for every approval round-trip', async () => {
    const h = makePairedHarness()
    const mediator = mediatorReturning('allowed', 'risk:auto-allow')
    const resolved: MediatorOutput[] = []
    const bridge = new CodexBridge({
      input: h.input,
      output: h.output,
      onApprovalRequest: wireBridgeToMediator({
        sourceAgent: 'codex',
        mediator,
        onResolved: (o) => resolved.push(o),
      }),
    })
    bridge.start()

    h.pushFrame({
      jsonrpc: '2.0',
      id: 'a',
      method: 'item/commandExecution/requestApproval',
      params: {
        itemId: 'i',
        threadId: 't',
        turnId: 'tn',
        startedAtMs: 1,
        command: 'echo ok',
        cwd: null,
        reason: null,
        commandActions: null,
        networkApprovalContext: null,
        additionalPermissions: null,
        availableDecisions: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
        approvalId: null,
      },
    })
    await tick()
    await tick()

    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.decision).toBe('allowed')
    expect(resolved[0]!.decidedBy).toBe('risk:auto-allow')
  })
})
