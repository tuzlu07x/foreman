/**
 * JsonRpcStdioBridge tests.
 *
 * The codex-bridge tests in `codex-bridge.test.ts` already exercise every
 * protocol-agnostic code path through the CodexBridge facade. This file
 * adds the proofs that the generic class itself works with arbitrary
 * approval-method sets + fail-closed reply shapes — the bits that
 * differ between codex and ACP transports.
 *
 * Coverage focus:
 *   - approval-method routing honours the caller-supplied set
 *   - non-approval server requests route to the `onOtherServerRequest`
 *     hook (or default to -32601 method-not-found when no hook)
 *   - fail-closed reply uses the caller-supplied factory (proves ACP-
 *     shaped responses like `{ outcome: { outcome: 'cancelled' } }`
 *     flow through correctly)
 *   - label propagation into error messages (so CodexBridge errors say
 *     "CodexBridge ..." not the generic default)
 */

import { describe, expect, it, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'

import { JsonRpcStdioBridge } from '../../src/core/jsonrpc-stdio-bridge.js'

// =============================================================================
// Paired in-memory streams + helpers
// =============================================================================

function makeStreams() {
  const writtenLines: string[] = []
  const output = new Writable({
    write(chunk, _enc, cb) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const part of text.split('\n')) {
        if (part.length > 0) writtenLines.push(part)
      }
      cb()
    },
  })
  const input = new Readable({ read() {} })
  return {
    input,
    output,
    writtenLines,
    pushFrame(f: unknown): void {
      input.push(JSON.stringify(f) + '\n')
    },
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

function parseFrame(line: string): {
  method?: string
  id?: number | string
  result?: unknown
  error?: { code: number; message: string }
} {
  return JSON.parse(line)
}

// =============================================================================
// Approval-method routing — protocol-agnostic
// =============================================================================

describe('JsonRpcStdioBridge — approval routing on a caller-supplied method set', () => {
  it('routes ANY method in approvalMethods to onApprovalRequest', async () => {
    const s = makeStreams()
    const handler = vi.fn(async (_req: unknown) => ({ ok: true }))
    const bridge = new JsonRpcStdioBridge<unknown, { ok: boolean }>({
      input: s.input,
      output: s.output,
      approvalMethods: new Set(['foo/bar', 'baz/qux']),
      onApprovalRequest: handler,
      failClosedReply: () => ({ ok: false }),
    })
    bridge.start()

    s.pushFrame({
      jsonrpc: '2.0',
      id: 1,
      method: 'foo/bar',
      params: { hello: 'world' },
    })
    await tick()
    await tick()
    expect(handler).toHaveBeenCalledTimes(1)
    const reply = parseFrame(s.writtenLines[0]!)
    expect(reply.id).toBe(1)
    expect(reply.result).toEqual({ ok: true })

    bridge.stop()
  })

  it('routes a method that is NOT in approvalMethods to onOtherServerRequest', async () => {
    const s = makeStreams()
    const approvalHandler = vi.fn(async () => ({ ok: true }))
    const otherHandler = vi.fn(async (method: string) => ({
      result: { handled: method } as const,
    }))
    const bridge = new JsonRpcStdioBridge<unknown, { ok: boolean }>({
      input: s.input,
      output: s.output,
      approvalMethods: new Set(['only/approve/this']),
      onApprovalRequest: approvalHandler,
      failClosedReply: () => ({ ok: false }),
      hooks: { onOtherServerRequest: otherHandler },
    })
    bridge.start()

    s.pushFrame({ jsonrpc: '2.0', id: 'x', method: 'something/else', params: {} })
    await tick()
    await tick()

    expect(approvalHandler).not.toHaveBeenCalled()
    expect(otherHandler).toHaveBeenCalledWith('something/else', {})

    bridge.stop()
  })

  it('emits the caller-supplied failClosedReply on handler throw', async () => {
    const s = makeStreams()
    const acpShapedFailClosed = () => ({ outcome: { outcome: 'cancelled' as const } })
    const bridge = new JsonRpcStdioBridge({
      input: s.input,
      output: s.output,
      approvalMethods: new Set(['session/request_permission']),
      onApprovalRequest: async () => {
        throw new Error('handler bomb')
      },
      failClosedReply: acpShapedFailClosed,
    })
    bridge.start()

    s.pushFrame({
      jsonrpc: '2.0',
      id: 'acp-1',
      method: 'session/request_permission',
      params: {},
    })
    await tick()
    await tick()

    const reply = parseFrame(s.writtenLines[0]!)
    expect(reply.id).toBe('acp-1')
    expect(reply.result).toEqual({ outcome: { outcome: 'cancelled' } })

    bridge.stop()
  })
})

// =============================================================================
// Label propagation — proves CodexBridge error messages stay codex-shaped
// =============================================================================

describe('JsonRpcStdioBridge — label propagation', () => {
  it('error messages from request()-before-start use the configured label', async () => {
    const s = makeStreams()
    const bridge = new JsonRpcStdioBridge({
      input: s.input,
      output: s.output,
      approvalMethods: new Set(),
      onApprovalRequest: async () => ({}),
      failClosedReply: () => ({}),
      label: 'MyAcpBridge',
    })
    await expect(bridge.request('anything')).rejects.toThrow(/MyAcpBridge/)
  })

  it('start-twice error uses the label too', () => {
    const s = makeStreams()
    const bridge = new JsonRpcStdioBridge({
      input: s.input,
      output: s.output,
      approvalMethods: new Set(),
      onApprovalRequest: async () => ({}),
      failClosedReply: () => ({}),
      label: 'AnotherBridge',
    })
    bridge.start()
    expect(() => bridge.start()).toThrow(/AnotherBridge/)
  })

  it('falls back to a sane default label when none is supplied', async () => {
    const s = makeStreams()
    const bridge = new JsonRpcStdioBridge({
      input: s.input,
      output: s.output,
      approvalMethods: new Set(),
      onApprovalRequest: async () => ({}),
      failClosedReply: () => ({}),
    })
    await expect(bridge.request('x')).rejects.toThrow(/jsonrpc-stdio-bridge/)
  })
})

// =============================================================================
// Generic typing — proves the bridge can be parameterised with arbitrary
// approval-request / approval-response types without TypeScript fighting
// the call site.
// =============================================================================

describe('JsonRpcStdioBridge — generic typing exercise', () => {
  interface MyRequest {
    method: string
    params: { command: string }
  }
  interface MyResponse {
    accepted: boolean
    reason?: string
  }

  it('compiles + runs with a custom request / response type pair', async () => {
    const s = makeStreams()
    const handler = vi.fn(
      async (req: MyRequest): Promise<MyResponse> => ({
        accepted: req.params.command === 'safe',
      }),
    )
    const bridge = new JsonRpcStdioBridge<MyRequest, MyResponse>({
      input: s.input,
      output: s.output,
      approvalMethods: new Set(['custom/approve']),
      onApprovalRequest: handler,
      failClosedReply: () => ({ accepted: false, reason: 'fail-closed' }),
    })
    bridge.start()

    s.pushFrame({
      jsonrpc: '2.0',
      id: 7,
      method: 'custom/approve',
      params: { command: 'safe' },
    })
    await tick()
    await tick()
    const reply = parseFrame(s.writtenLines[0]!)
    expect(reply.result).toEqual({ accepted: true })

    bridge.stop()
  })
})
