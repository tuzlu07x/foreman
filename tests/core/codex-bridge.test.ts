/**
 * CodexBridge tests (#552 PR 3).
 *
 * Drives the bridge with in-memory streams so we cover the full protocol
 * surface — client requests, server requests, notifications, errors,
 * malformed frames — without spawning a real codex process.
 */

import { describe, expect, it, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { CodexBridge, type CodexApprovalWireRequest } from '../../src/core/codex-bridge.js'

// =============================================================================
// Test harness — paired in-memory streams + helpers
// =============================================================================

/** A duplex pair: `output.input` is what Foreman writes into codex,
 *  `input.output` is what codex writes into Foreman. The bridge reads
 *  from `input` and writes to `output`. */
function makeStreams() {
  const writtenLines: string[] = []
  const output = new Writable({
    write(chunk, _enc, cb) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      // Split on newlines so the test sees one entry per frame.
      for (const part of text.split('\n')) {
        if (part.length > 0) writtenLines.push(part)
      }
      cb()
    },
  })

  // A passthrough-ish Readable we can push() into from the test.
  const input = new Readable({ read() {} })

  return {
    input,
    output,
    writtenLines,
    /** Helper — push a JSON-RPC frame as if codex had emitted it. */
    pushFrame(frame: unknown): void {
      input.push(JSON.stringify(frame) + '\n')
    },
    /** Helper — push raw text (for malformed-frame tests). */
    pushText(text: string): void {
      input.push(text)
    },
    /** Helper — drop the codex side. */
    endInput(): void {
      input.push(null)
    },
  }
}

/** Sleep one microtask tick so the bridge's data handler can run. */
async function tick(): Promise<void> {
  await new Promise((r) => setImmediate(r))
}

function parseFrame(line: string): { method?: string; id?: number | string; result?: unknown; error?: unknown; params?: unknown } {
  return JSON.parse(line)
}

// =============================================================================
// Client → server (Foreman → codex) requests
// =============================================================================

describe('CodexBridge — client requests', () => {
  it('writes a JSON-RPC request and resolves with the server result', async () => {
    const s = makeStreams()
    const bridge = new CodexBridge({
      input: s.input,
      output: s.output,
      onApprovalRequest: async () => ({ decision: 'accept' }),
    })
    bridge.start()

    const promise = bridge.request('initialize', { clientName: 'foreman' })
    await tick()
    expect(s.writtenLines).toHaveLength(1)
    const sent = parseFrame(s.writtenLines[0]!)
    expect(sent.method).toBe('initialize')
    expect(sent.id).toBe(1)
    expect((sent.params as { clientName: string }).clientName).toBe('foreman')

    s.pushFrame({ jsonrpc: '2.0', id: sent.id, result: { ok: true } })
    await tick()
    await expect(promise).resolves.toEqual({ ok: true })
  })

  it('rejects when the server returns a JSON-RPC error', async () => {
    const s = makeStreams()
    const bridge = new CodexBridge({
      input: s.input,
      output: s.output,
      onApprovalRequest: async () => ({ decision: 'decline' }),
    })
    bridge.start()

    const promise = bridge.request('thread/start', {})
    await tick()
    const sent = parseFrame(s.writtenLines[0]!)
    s.pushFrame({
      jsonrpc: '2.0',
      id: sent.id,
      error: { code: -32602, message: 'missing field `clientName`' },
    })
    await expect(promise).rejects.toThrow(/missing field `clientName`/)
  })

  it('assigns distinct ids to back-to-back requests', async () => {
    const s = makeStreams()
    const bridge = new CodexBridge({
      input: s.input,
      output: s.output,
      onApprovalRequest: async () => ({ decision: 'accept' }),
    })
    bridge.start()
    void bridge.request('a', {})
    void bridge.request('b', {})
    await tick()
    expect(s.writtenLines).toHaveLength(2)
    const ids = s.writtenLines.map((l) => parseFrame(l).id)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('rejects pending requests when the codex stream ends', async () => {
    const s = makeStreams()
    const bridge = new CodexBridge({
      input: s.input,
      output: s.output,
      onApprovalRequest: async () => ({ decision: 'accept' }),
    })
    bridge.start()
    const promise = bridge.request('thread/start')
    s.endInput()
    await expect(promise).rejects.toThrow(/stream ended/)
  })

  it('refuses request() before start()', async () => {
    const s = makeStreams()
    const bridge = new CodexBridge({
      input: s.input,
      output: s.output,
      onApprovalRequest: async () => ({ decision: 'accept' }),
    })
    await expect(bridge.request('initialize')).rejects.toThrow(/start\(\) must be called/)
  })

  it('throws on duplicate start()', () => {
    const s = makeStreams()
    const bridge = new CodexBridge({
      input: s.input,
      output: s.output,
      onApprovalRequest: async () => ({ decision: 'accept' }),
    })
    bridge.start()
    expect(() => bridge.start()).toThrow(/start\(\) called twice/)
  })

  it('stop() rejects subsequent requests', async () => {
    const s = makeStreams()
    const bridge = new CodexBridge({
      input: s.input,
      output: s.output,
      onApprovalRequest: async () => ({ decision: 'accept' }),
    })
    bridge.start()
    bridge.stop()
    await expect(bridge.request('anything')).rejects.toThrow(/is stopped/)
  })

  it('notify() writes a frame without an id', async () => {
    const s = makeStreams()
    const bridge = new CodexBridge({
      input: s.input,
      output: s.output,
      onApprovalRequest: async () => ({ decision: 'accept' }),
    })
    bridge.start()
    bridge.notify('thread/unsubscribe', { threadId: 't' })
    await tick()
    const sent = parseFrame(s.writtenLines[0]!)
    expect(sent.id).toBeUndefined()
    expect(sent.method).toBe('thread/unsubscribe')
  })
})

// =============================================================================
// Server → client (codex → Foreman) approval dispatch
// =============================================================================

describe('CodexBridge — approval dispatch', () => {
  it('routes item/commandExecution/requestApproval to the handler and writes back', async () => {
    const s = makeStreams()
    const handler = vi.fn(async (req: CodexApprovalWireRequest) => {
      expect(req.method).toBe('item/commandExecution/requestApproval')
      return { decision: 'accept' as const }
    })
    const bridge = new CodexBridge({
      input: s.input,
      output: s.output,
      onApprovalRequest: handler,
    })
    bridge.start()

    s.pushFrame({
      jsonrpc: '2.0',
      id: 'approval_1',
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'i', threadId: 't', turnId: 'tn', startedAtMs: 1, command: 'ls' },
    })
    await tick()
    await tick() // handler is async — give it a turn

    expect(handler).toHaveBeenCalledTimes(1)
    expect(s.writtenLines).toHaveLength(1)
    const reply = parseFrame(s.writtenLines[0]!)
    expect(reply.id).toBe('approval_1')
    expect(reply.result).toEqual({ decision: 'accept' })
  })

  it('routes item/fileChange/requestApproval to the handler', async () => {
    const s = makeStreams()
    const handler = vi.fn(async () => ({ decision: 'decline' as const }))
    const bridge = new CodexBridge({
      input: s.input,
      output: s.output,
      onApprovalRequest: handler,
    })
    bridge.start()

    s.pushFrame({
      jsonrpc: '2.0',
      id: 42,
      method: 'item/fileChange/requestApproval',
      params: { itemId: 'fc', threadId: 't', turnId: 'tn' },
    })
    await tick()
    await tick()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(parseFrame(s.writtenLines[0]!).result).toEqual({ decision: 'decline' })
  })

  it('falls back to decline when the handler throws (fail-closed)', async () => {
    const s = makeStreams()
    const onTransportError = vi.fn()
    const bridge = new CodexBridge({
      input: s.input,
      output: s.output,
      onApprovalRequest: async () => {
        throw new Error('handler exploded')
      },
      hooks: { onTransportError },
    })
    bridge.start()

    s.pushFrame({
      jsonrpc: '2.0',
      id: 'oops',
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'i', threadId: 't', turnId: 'tn', startedAtMs: 1 },
    })
    await tick()
    await tick()

    expect(onTransportError).toHaveBeenCalled()
    expect(parseFrame(s.writtenLines[0]!).result).toEqual({ decision: 'decline' })
  })
})

// =============================================================================
// Non-approval server requests
// =============================================================================

describe('CodexBridge — other server requests', () => {
  it('replies with -32601 when no override is provided', async () => {
    const s = makeStreams()
    const bridge = new CodexBridge({
      input: s.input,
      output: s.output,
      onApprovalRequest: async () => ({ decision: 'accept' }),
    })
    bridge.start()

    s.pushFrame({
      jsonrpc: '2.0',
      id: 'elicit_1',
      method: 'mcpServer/elicitation/request',
      params: {},
    })
    await tick()
    await tick()

    const reply = parseFrame(s.writtenLines[0]!)
    expect((reply.error as { code: number }).code).toBe(-32601)
  })

  it('calls onOtherServerRequest when supplied', async () => {
    const s = makeStreams()
    const onOtherServerRequest = vi.fn(async (method: string) => {
      expect(method).toBe('mcpServer/elicitation/request')
      return { result: { handled: true } } as const
    })
    const bridge = new CodexBridge({
      input: s.input,
      output: s.output,
      onApprovalRequest: async () => ({ decision: 'accept' }),
      hooks: { onOtherServerRequest },
    })
    bridge.start()

    s.pushFrame({
      jsonrpc: '2.0',
      id: 'e1',
      method: 'mcpServer/elicitation/request',
      params: {},
    })
    await tick()
    await tick()

    expect(onOtherServerRequest).toHaveBeenCalledTimes(1)
    expect(parseFrame(s.writtenLines[0]!).result).toEqual({ handled: true })
  })
})

// =============================================================================
// Notifications + framing edge cases
// =============================================================================

describe('CodexBridge — notifications and framing', () => {
  it('forwards server notifications to the hook', async () => {
    const s = makeStreams()
    const onNotification = vi.fn()
    const bridge = new CodexBridge({
      input: s.input,
      output: s.output,
      onApprovalRequest: async () => ({ decision: 'accept' }),
      hooks: { onNotification },
    })
    bridge.start()
    s.pushFrame({
      jsonrpc: '2.0',
      method: 'thread/started',
      params: { threadId: 't' },
    })
    await tick()
    expect(onNotification).toHaveBeenCalledWith('thread/started', { threadId: 't' })
  })

  it('handles split frames across multiple data chunks', async () => {
    const s = makeStreams()
    const bridge = new CodexBridge({
      input: s.input,
      output: s.output,
      onApprovalRequest: async () => ({ decision: 'accept' }),
    })
    bridge.start()

    const promise = bridge.request('initialize')
    await tick()
    const sentId = parseFrame(s.writtenLines[0]!).id

    // Split a single response frame across two chunks.
    const fullFrame = JSON.stringify({ jsonrpc: '2.0', id: sentId, result: { ok: 1 } }) + '\n'
    const half = Math.floor(fullFrame.length / 2)
    s.pushText(fullFrame.slice(0, half))
    await tick()
    s.pushText(fullFrame.slice(half))
    await tick()

    await expect(promise).resolves.toEqual({ ok: 1 })
  })

  it('handles two frames in one chunk', async () => {
    const s = makeStreams()
    const seen: string[] = []
    const bridge = new CodexBridge({
      input: s.input,
      output: s.output,
      onApprovalRequest: async () => ({ decision: 'accept' }),
      hooks: { onNotification: (m) => seen.push(m) },
    })
    bridge.start()

    const a = JSON.stringify({ jsonrpc: '2.0', method: 'a', params: {} })
    const b = JSON.stringify({ jsonrpc: '2.0', method: 'b', params: {} })
    s.pushText(`${a}\n${b}\n`)
    await tick()
    expect(seen).toEqual(['a', 'b'])
  })

  it('surfaces a parse error via onTransportError but keeps going', async () => {
    const s = makeStreams()
    const onTransportError = vi.fn()
    const bridge = new CodexBridge({
      input: s.input,
      output: s.output,
      onApprovalRequest: async () => ({ decision: 'accept' }),
      hooks: { onTransportError },
    })
    bridge.start()
    s.pushText('{not valid json}\n')
    await tick()
    expect(onTransportError).toHaveBeenCalled()
    // A subsequent valid frame still works.
    s.pushFrame({ jsonrpc: '2.0', method: 'ok', params: {} })
    await tick()
    // Nothing thrown / process still healthy — implicit pass.
  })
})
