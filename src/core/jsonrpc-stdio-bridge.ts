/**
 * Generic JSON-RPC 2.0 over stdio bridge.
 *
 * The protocol-agnostic core that `CodexBridge` (codex exec-server) and any
 * future agent bridge — including the Agent Client Protocol (ACP) bridge
 * Hermes / OpenClaw / ZeroClaw will use — build on top of.
 *
 * Two roles, one transport:
 *
 *   1. **Client direction** — Foreman calls `request(method, params)` or
 *      `notify(method, params)` to send JSON-RPC frames to the child.
 *      `request()` returns a promise that resolves with the server's
 *      `result` (or rejects with the JSON-RPC error envelope).
 *
 *   2. **Server direction** — the child emits server requests + server
 *      notifications. Approval-flavoured server requests (the protocol-
 *      specific set passed in `approvalMethods`) route to
 *      `onApprovalRequest`; everything else routes to the optional
 *      `onOtherServerRequest` hook; notifications go to `onNotification`.
 *
 * Wire format is newline-delimited JSON-RPC 2.0. Confirmed against codex
 * v0.133.0 (#552 investigation) and the ACP spec.
 *
 * Generic parameters:
 *   - `TApprovalRequest`: the protocol's approval-request payload type
 *     (e.g. `CodexApprovalWireRequest` for codex, `AcpWireRequest` for
 *     ACP). The handler receives this; the bridge does no validation
 *     beyond `method` routing.
 *   - `TApprovalResponse`: the wire shape the handler returns. The
 *     bridge serialises it as the JSON-RPC `result` of the original
 *     request.
 *
 * Fail-closed: if `onApprovalRequest` throws, the bridge writes the
 * supplied `failClosedReply()` as the result so the agent doesn't
 * hang. The default at the protocol layer is:
 *   - codex: `{ decision: 'decline' }`
 *   - ACP: `{ outcome: { outcome: 'cancelled' } }`
 */

import type { Readable, Writable } from 'node:stream'
import { Buffer } from 'node:buffer'

// =============================================================================
// JSON-RPC message shapes — narrow models. Not imported from
// `src/mcp/types.ts` because that targets Foreman's MCP server while this
// bridge talks to agent-side protocols. Keeping the two shapes separate
// avoids accidental coupling.
// =============================================================================

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

interface JsonRpcResponseResult {
  jsonrpc: '2.0'
  id: number | string
  result: unknown
}

interface JsonRpcResponseError {
  jsonrpc: '2.0'
  id: number | string | null
  error: { code: number; message: string; data?: unknown }
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponseResult
  | JsonRpcResponseError
  | JsonRpcNotification

// =============================================================================
// Public hooks + options
// =============================================================================

/** Optional sinks for non-approval traffic. Defaults are silent so a
 *  minimal call site only wires what it needs. */
export interface JsonRpcStdioBridgeHooks {
  /** Called for every server-initiated notification (e.g. `thread/started`,
   *  `session/update`). Returns are ignored. */
  onNotification?(method: string, params: unknown): void
  /** Called for server-initiated requests whose method is NOT in
   *  `approvalMethods`. Default behaviour responds with a JSON-RPC
   *  method-not-found error so the agent doesn't hang. Callers can
   *  override to handle e.g. ACP's `fs/read_text_file` or
   *  `terminal/create` themselves. */
  onOtherServerRequest?(
    method: string,
    params: unknown,
  ): Promise<{ result: unknown } | { error: { code: number; message: string } }>
  /** Optional diagnostic sink — every transport / parse / handler error
   *  surfaces here. Defaults to no-op. */
  onTransportError?(err: Error): void
}

/** Generic bridge handler. Receives the protocol's approval-request
 *  payload (typed by the caller via the bridge's generic) and returns
 *  the protocol's response payload. The handler MUST NOT throw — return
 *  a deny-equivalent on any internal failure so the agent unblocks
 *  instead of stalling. (The bridge ALSO substitutes a fail-closed
 *  reply on throw as a defence-in-depth measure.) */
export type JsonRpcStdioApprovalHandler<TApprovalRequest, TApprovalResponse> = (
  request: TApprovalRequest,
) => Promise<TApprovalResponse>

export interface JsonRpcStdioBridgeOptions<TApprovalRequest, TApprovalResponse> {
  /** Stream the child writes JSON-RPC frames to (its stdout). */
  input: Readable
  /** Stream Foreman writes JSON-RPC frames to (the child's stdin). */
  output: Writable
  /** Method names this bridge treats as approval-flavoured. Anything
   *  else falls through to `onOtherServerRequest`. Protocol-specific —
   *  caller supplies the set when constructing the bridge. */
  approvalMethods: ReadonlySet<string>
  /** Approval dispatcher. Required. See JsonRpcStdioApprovalHandler. */
  onApprovalRequest: JsonRpcStdioApprovalHandler<TApprovalRequest, TApprovalResponse>
  /** Fail-closed wire reply when `onApprovalRequest` throws. The shape
   *  depends on the protocol — codex wants `{ decision: 'decline' }`,
   *  ACP wants `{ outcome: { outcome: 'cancelled' } }`. */
  failClosedReply: () => TApprovalResponse
  /** Optional non-approval hooks. */
  hooks?: JsonRpcStdioBridgeHooks
  /** Optional label used in error messages. Defaults to
   *  `'jsonrpc-stdio-bridge'`. */
  label?: string
}

// =============================================================================
// Bridge
// =============================================================================

export class JsonRpcStdioBridge<TApprovalRequest = unknown, TApprovalResponse = unknown> {
  private nextRequestId = 1
  private readonly pending = new Map<
    number | string,
    {
      resolve: (value: unknown) => void
      reject: (err: Error) => void
    }
  >()

  /** Line buffer — newline-delimited JSON is the wire format. */
  private buffer = ''
  private started = false
  private stopped = false

  private readonly label: string

  constructor(
    private readonly opts: JsonRpcStdioBridgeOptions<TApprovalRequest, TApprovalResponse>,
  ) {
    this.label = opts.label ?? 'jsonrpc-stdio-bridge'
  }

  /**
   * Wire up stream listeners. Idempotent — calling twice on the same
   * instance throws so accidental double-starts surface loudly.
   */
  start(): void {
    if (this.started) {
      throw new Error(`${this.label}.start() called twice on the same instance`)
    }
    this.started = true

    this.opts.input.setEncoding('utf8')
    this.opts.input.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      this.handleData(text)
    })
    this.opts.input.on('error', (err: Error) => {
      this.opts.hooks?.onTransportError?.(err)
      this.failAllPending(err)
    })
    this.opts.input.on('end', () => {
      this.failAllPending(new Error(`${this.label} stream ended`))
    })
  }

  /**
   * Mark the bridge as stopped + fail every pending client request.
   * Does NOT touch the underlying streams; lifecycle is the caller's
   * job (the spawn helper owns process lifecycle).
   */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.failAllPending(new Error(`${this.label} stopped`))
  }

  /**
   * Send a JSON-RPC request to the child (Foreman → server direction)
   * and resolve with the server's `result`. Rejects with a JSON-RPC
   * error envelope if the server returns one, or with a generic Error
   * if the transport fails.
   */
  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.started) {
      return Promise.reject(
        new Error(`${this.label}.start() must be called first`),
      )
    }
    if (this.stopped) {
      return Promise.reject(new Error(`${this.label} is stopped`))
    }
    const id = this.nextRequestId++
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.writeFrame(msg)
    })
  }

  /** Convenience: fire-and-forget client notification. */
  notify(method: string, params?: unknown): void {
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params }
    this.writeFrame(msg)
  }

  // ---------------------------------------------------------------------------
  // Internal — incoming data path
  // ---------------------------------------------------------------------------

  private handleData(text: string): void {
    this.buffer += text
    let newlineIdx: number
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim()
      this.buffer = this.buffer.slice(newlineIdx + 1)
      if (line.length === 0) continue
      this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    let parsed: JsonRpcMessage
    try {
      parsed = JSON.parse(line) as JsonRpcMessage
    } catch (err) {
      this.opts.hooks?.onTransportError?.(
        err instanceof Error ? err : new Error(String(err)),
      )
      return
    }
    if ('id' in parsed && !('method' in parsed)) {
      this.handleResponse(parsed as JsonRpcResponseResult | JsonRpcResponseError)
      return
    }
    if ('method' in parsed && 'id' in parsed) {
      // ServerRequest — child asking us something.
      this.handleServerRequest(parsed as JsonRpcRequest)
      return
    }
    if ('method' in parsed) {
      this.opts.hooks?.onNotification?.(
        parsed.method,
        (parsed as JsonRpcNotification).params,
      )
      return
    }
    // Unrecognised frame — surface as transport error but don't crash.
    this.opts.hooks?.onTransportError?.(
      new Error(`unrecognised JSON-RPC frame: ${line.slice(0, 200)}`),
    )
  }

  private handleResponse(
    msg: JsonRpcResponseResult | JsonRpcResponseError,
  ): void {
    if (msg.id === null || msg.id === undefined) return
    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.pending.delete(msg.id)
    if ('error' in msg) {
      const e = new Error(
        `${this.label} server error ${msg.error.code}: ${msg.error.message}`,
      )
      ;(e as Error & { rpcError?: typeof msg.error }).rpcError = msg.error
      pending.reject(e)
      return
    }
    pending.resolve(msg.result)
  }

  private async handleServerRequest(req: JsonRpcRequest): Promise<void> {
    if (this.opts.approvalMethods.has(req.method)) {
      // Approval dispatch — wrap params as the protocol's typed shape
      // and call the handler. Any throw from the handler is converted
      // into the protocol's fail-closed reply so the agent unblocks
      // instead of hanging on its end of the pipe.
      const wire = {
        method: req.method,
        params: req.params,
      } as unknown as TApprovalRequest
      try {
        const reply = await this.opts.onApprovalRequest(wire)
        this.writeFrame({
          jsonrpc: '2.0',
          id: req.id,
          result: reply,
        })
      } catch (err) {
        this.opts.hooks?.onTransportError?.(
          err instanceof Error ? err : new Error(String(err)),
        )
        this.writeFrame({
          jsonrpc: '2.0',
          id: req.id,
          result: this.opts.failClosedReply(),
        })
      }
      return
    }

    // Non-approval server request. Caller may override; default is
    // "method not found" so the agent unblocks rather than hangs.
    const hook = this.opts.hooks?.onOtherServerRequest
    if (!hook) {
      this.writeFrame({
        jsonrpc: '2.0',
        id: req.id,
        error: {
          code: -32601,
          message: `Method not handled by Foreman bridge: ${req.method}`,
        },
      })
      return
    }
    try {
      const reply = await hook(req.method, req.params)
      if ('result' in reply) {
        this.writeFrame({ jsonrpc: '2.0', id: req.id, result: reply.result })
      } else {
        this.writeFrame({
          jsonrpc: '2.0',
          id: req.id,
          error: reply.error,
        })
      }
    } catch (err) {
      this.opts.hooks?.onTransportError?.(
        err instanceof Error ? err : new Error(String(err)),
      )
      this.writeFrame({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32603, message: 'Internal error in Foreman hook' },
      })
    }
  }

  private writeFrame(msg: JsonRpcMessage): void {
    if (this.stopped) return
    const line = JSON.stringify(msg) + '\n'
    try {
      this.opts.output.write(line)
    } catch (err) {
      this.opts.hooks?.onTransportError?.(
        err instanceof Error ? err : new Error(String(err)),
      )
    }
  }

  private failAllPending(err: Error): void {
    for (const { reject } of this.pending.values()) {
      reject(err)
    }
    this.pending.clear()
  }
}
