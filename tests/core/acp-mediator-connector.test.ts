/**
 * ACP connector tests — proves the handler returned by
 * wireAcpBridgeToMediator routes through adapter → mediator → adapter
 * correctly for the four normalised decision kinds + the failure paths.
 *
 * Mirrors `codex-mediator-connector.test.ts`. Reviewing both side-by-
 * side should surface only the protocol-specific deltas (ACP's
 * outcome union vs codex's decision field).
 */

import { describe, expect, it, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'

import { wireAcpBridgeToMediator } from '../../src/core/acp-mediator-connector.js'
import {
  ACP_APPROVAL_METHODS,
  type AcpPermissionOption,
  type AcpRequestPermissionResponse,
  type AcpToolCall,
  type AcpWireRequest,
} from '../../src/core/adapters/index.js'
import type { MediatorLike } from '../../src/core/codex-mediator-connector.js'
import { JsonRpcStdioBridge } from '../../src/core/jsonrpc-stdio-bridge.js'
import type {
  MediatorInput,
  MediatorOutput,
} from '../../src/core/mediator.js'

// =============================================================================
// Fixtures
// =============================================================================

const STANDARD_OPTIONS: AcpPermissionOption[] = [
  { optionId: 'opt-allow', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'opt-allow-always', name: 'Allow + remember', kind: 'allow_always' },
  { optionId: 'opt-reject', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'opt-reject-always', name: 'Reject + remember', kind: 'reject_always' },
]

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
    requestId: 'req',
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

function shellApproval(
  command: string,
  options: AcpPermissionOption[] = STANDARD_OPTIONS,
): AcpWireRequest {
  const toolCall: AcpToolCall = {
    toolCallId: 'call_1',
    title: `run ${command}`,
    kind: 'execute',
    rawInput: { command },
  }
  return {
    method: 'session/request_permission',
    params: { sessionId: 'sess-1', toolCall, options },
  }
}

// =============================================================================
// Standalone handler — adapter → mediator → adapter
// =============================================================================

describe('wireAcpBridgeToMediator — allow path', () => {
  it('selects allow_once when mediator allows', async () => {
    const mediator = mediatorReturning('allowed')
    const handler = wireAcpBridgeToMediator({ sourceAgent: 'hermes', mediator })
    const out = await handler(shellApproval('ls /tmp'))

    expect(mediator.handleRequest).toHaveBeenCalledTimes(1)
    const arg = mediator.handleRequest.mock.calls[0]![0]
    expect(arg.sourceAgent).toBe('hermes')
    expect(arg.targetTool).toBe('shell_exec')
    expect(arg.sessionId).toBe('sess-1')

    expect(out.outcome).toEqual({ outcome: 'selected', optionId: 'opt-allow' })
  })
})

describe('wireAcpBridgeToMediator — deny path', () => {
  it('selects reject_once when mediator denies', async () => {
    const mediator = mediatorReturning('denied', 'risk:auto-deny', [
      'destructive_rm',
    ])
    const handler = wireAcpBridgeToMediator({ sourceAgent: 'hermes', mediator })
    const out = await handler(shellApproval('rm -rf /'))
    expect(out.outcome).toEqual({ outcome: 'selected', optionId: 'opt-reject' })
  })

  it('falls back to cancelled when the agent offered no reject_* option', async () => {
    const allowOnly: AcpPermissionOption[] = [
      { optionId: 'opt-allow', name: 'Allow once', kind: 'allow_once' },
    ]
    const mediator = mediatorReturning('denied', 'risk:auto-deny')
    const handler = wireAcpBridgeToMediator({ sourceAgent: 'hermes', mediator })
    const out = await handler(shellApproval('rm', allowOnly))
    expect(out.outcome).toEqual({ outcome: 'cancelled' })
  })
})

describe('wireAcpBridgeToMediator — fail-closed', () => {
  it('returns cancelled when the adapter cannot decode the wire payload', async () => {
    const mediator = mediatorReturning('allowed')
    const handler = wireAcpBridgeToMediator({ sourceAgent: 'hermes', mediator })
    // Empty sessionId trips the adapter's runtime guard.
    const broken = shellApproval('ls')
    broken.params.sessionId = ''
    const out = await handler(broken)

    expect(mediator.handleRequest).not.toHaveBeenCalled()
    expect(out.outcome).toEqual({ outcome: 'cancelled' })
  })

  it('returns cancelled when the mediator throws', async () => {
    const mediator: MediatorLike = {
      handleRequest: vi.fn(
        async (_input: MediatorInput): Promise<MediatorOutput> => {
          throw new Error('db wedged')
        },
      ),
    }
    const handler = wireAcpBridgeToMediator({ sourceAgent: 'hermes', mediator })
    const out = await handler(shellApproval('ls'))
    // Mediator throw uses the OFFERED options for the rejection,
    // so it lands on reject_once (not cancelled).
    expect(out.outcome).toEqual({ outcome: 'selected', optionId: 'opt-reject' })
  })
})

describe('wireAcpBridgeToMediator — onResolved hook', () => {
  it('fires the diagnostic hook with the mediator output', async () => {
    const mediator = mediatorReturning('allowed', 'risk:auto-allow')
    const resolved: MediatorOutput[] = []
    const handler = wireAcpBridgeToMediator({
      sourceAgent: 'hermes',
      mediator,
      onResolved: (o) => resolved.push(o),
    })
    await handler(shellApproval('echo hi'))
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.decidedBy).toBe('risk:auto-allow')
  })
})

// =============================================================================
// End-to-end with a real bridge — proves frames round-trip
// =============================================================================

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
    pushFrame(f: unknown): void {
      input.push(JSON.stringify(f) + '\n')
    },
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('JsonRpcStdioBridge + ACP connector — integration', () => {
  it('emits an ACP selected outcome on the wire when mediator allows', async () => {
    const h = makePairedHarness()
    const mediator = mediatorReturning('allowed')
    const bridge = new JsonRpcStdioBridge<
      AcpWireRequest,
      AcpRequestPermissionResponse
    >({
      input: h.input,
      output: h.output,
      approvalMethods: new Set(ACP_APPROVAL_METHODS),
      onApprovalRequest: wireAcpBridgeToMediator({
        sourceAgent: 'hermes',
        mediator,
      }),
      failClosedReply: () => ({ outcome: { outcome: 'cancelled' as const } }),
      label: 'AcpBridge',
    })
    bridge.start()

    h.pushFrame({
      jsonrpc: '2.0',
      id: 'acp-req-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'sess-end-to-end',
        toolCall: {
          toolCallId: 'tc-1',
          title: 'run ls',
          kind: 'execute',
          rawInput: { command: 'ls' },
        },
        options: STANDARD_OPTIONS,
      },
    })
    await tick()
    await tick()

    expect(h.written).toHaveLength(1)
    const reply = JSON.parse(h.written[0]!)
    expect(reply.id).toBe('acp-req-1')
    expect(reply.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-allow' },
    })
    bridge.stop()
  })

  it('emits cancelled when the handler throws (bridge fail-closed)', async () => {
    const h = makePairedHarness()
    const bridge = new JsonRpcStdioBridge<
      AcpWireRequest,
      AcpRequestPermissionResponse
    >({
      input: h.input,
      output: h.output,
      approvalMethods: new Set(ACP_APPROVAL_METHODS),
      onApprovalRequest: async () => {
        throw new Error('connector kaboom')
      },
      failClosedReply: () => ({ outcome: { outcome: 'cancelled' as const } }),
      label: 'AcpBridge',
    })
    bridge.start()

    h.pushFrame({
      jsonrpc: '2.0',
      id: 'kaboom',
      method: 'session/request_permission',
      params: {
        sessionId: 's',
        toolCall: { toolCallId: 'tc', title: 't', kind: 'execute' },
        options: STANDARD_OPTIONS,
      },
    })
    await tick()
    await tick()

    const reply = JSON.parse(h.written[0]!)
    expect(reply.id).toBe('kaboom')
    expect(reply.result).toEqual({ outcome: { outcome: 'cancelled' } })
    bridge.stop()
  })
})
