/**
 * Codex exec-server transport bridge (#552 PR 3).
 *
 * Speaks JSON-RPC 2.0 with `codex exec-server --listen stdio`. Foreman is the
 * client; codex is the server. The bridge plays two roles:
 *
 *   1. **Client** — Foreman sends client requests (initialize, thread/start,
 *      turn/interrupt, …) and receives results / errors.
 *   2. **Server** — Codex sends server requests during a turn (the seven
 *      `item/<x>/requestApproval` + elicitation methods documented in #552);
 *      the bridge routes them to an injected `onApprovalRequest` handler and
 *      writes the handler's response back.
 *
 * Wire format is newline-delimited JSON. Confirmed empirically against codex
 * v0.133.0:
 *
 *     { echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
 *       sleep 3
 *     } | codex exec-server --listen stdio
 *     {"error":{"code":-32602,"message":"missing field `clientName`"},"id":1}
 *
 * This module deliberately accepts arbitrary `Readable` / `Writable` streams
 * rather than spawning codex itself. PR 4 wires it to the spawn engine; for
 * PR 3 it stays a pure protocol component so unit tests can drive it with
 * in-memory streams.
 *
 * Approval-method routing is intentionally NOT hard-coded to a specific
 * adapter. The caller supplies `onApprovalRequest(wire)`; the bridge simply
 * forwards the JSON-RPC params verbatim and serialises the handler's wire
 * response back. This keeps the bridge agnostic of which adapter the caller
 * uses (codex-exec-server-v1 today; conceivably v2 later).
 */

import type { Readable, Writable } from 'node:stream'
import { Buffer } from 'node:buffer'

import type {
  CodexApprovalMethod,
  CodexCommandExecutionRequestApprovalParams,
  CodexFileChangeRequestApprovalParams,
  CodexPermissionsRequestApprovalParams,
} from './adapters/index.js'

// =============================================================================
// JSON-RPC message shapes — narrow models, intentionally not a full type
// import from `src/mcp/types.ts` because that file targets the Foreman-side
// MCP server while this bridge talks to codex's exec-server. Keeping the
// two shapes separate avoids accidental coupling.
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
// Public contract
// =============================================================================

/**
 * Tagged union of every approval-request shape the bridge dispatches. The
 * handler receives the same shape `codexExecServerV1Adapter.decodeRequest`
 * expects so the call site can pipe it straight through.
 */
export type CodexApprovalWireRequest =
  | {
      method: 'item/commandExecution/requestApproval'
      params: CodexCommandExecutionRequestApprovalParams
    }
  | {
      method: 'item/fileChange/requestApproval'
      params: CodexFileChangeRequestApprovalParams
    }
  | {
      method: 'item/permissions/requestApproval'
      params: CodexPermissionsRequestApprovalParams
    }

/**
 * The bridge calls this for every codex → Foreman approval request. The
 * handler decodes via the adapter, runs the mediator, and returns the
 * adapter-encoded `decision` payload that the bridge sends back as the
 * JSON-RPC result. The handler MUST NOT throw — return a `decline`
 * decision on any internal failure so codex unblocks instead of stalling.
 */
export type CodexApprovalHandler = (
  request: CodexApprovalWireRequest,
) => Promise<{ decision: unknown }>

/** Optional sinks for non-approval traffic. Defaults are silent so a
 *  minimal call site only wires what it needs. */
export interface CodexBridgeHooks {
  /** Called for every server-initiated notification (`thread/started`,
   *  `item.completed`, …). Returns are ignored. */
  onNotification?(method: string, params: unknown): void
  /** Called for server-initiated requests whose method is not an approval
   *  method (currently only `mcpServer/elicitation/request`). Default
   *  behaviour responds with a JSON-RPC method-not-found error so codex
   *  doesn't hang. Callers can override to implement elicitation if they
   *  want. */
  onOtherServerRequest?(
    method: string,
    params: unknown,
  ): Promise<{ result: unknown } | { error: { code: number; message: string } }>
  /** Optional diagnostic sink. Defaults to no-op. */
  onTransportError?(err: Error): void
}

export interface CodexBridgeOptions {
  /** Stream codex writes JSON-RPC frames to (its stdout). */
  input: Readable
  /** Stream Foreman writes JSON-RPC frames to (codex's stdin). */
  output: Writable
  /** Approval request dispatcher. Required. */
  onApprovalRequest: CodexApprovalHandler
  /** Optional non-approval hooks. */
  hooks?: CodexBridgeHooks
}

const APPROVAL_METHODS = new Set<CodexApprovalMethod>([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
])

function isApprovalMethod(m: string): m is CodexApprovalMethod {
  return APPROVAL_METHODS.has(m as CodexApprovalMethod)
}

// =============================================================================
// Bridge
// =============================================================================

export class CodexBridge {
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

  constructor(private readonly opts: CodexBridgeOptions) {}

  /**
   * Wire up stream listeners. Idempotent — calling twice on the same
   * instance throws so accidental double-starts surface loudly.
   */
  start(): void {
    if (this.started) {
      throw new Error('CodexBridge.start() called twice on the same instance')
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
      this.failAllPending(new Error('codex exec-server stream ended'))
    })
  }

  /**
   * Mark the bridge as stopped + fail every pending client request. Does
   * NOT touch the underlying streams; lifecycle is the caller's job (PR 4
   * owns the spawn lifecycle).
   */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.failAllPending(new Error('CodexBridge stopped'))
  }

  /**
   * Send a JSON-RPC request to codex (Foreman → server direction) and
   * resolve with the server's `result`. Rejects with a JSON-RPC error
   * envelope if the server returns one, or with a generic Error if the
   * transport fails.
   */
  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.started) {
      return Promise.reject(new Error('CodexBridge.start() must be called first'))
    }
    if (this.stopped) {
      return Promise.reject(new Error('CodexBridge is stopped'))
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
      // ServerRequest — codex asking us something.
      this.handleServerRequest(parsed as JsonRpcRequest)
      return
    }
    if ('method' in parsed) {
      this.opts.hooks?.onNotification?.(parsed.method, (parsed as JsonRpcNotification).params)
      return
    }
    // Unrecognised frame — surface as transport error but don't crash.
    this.opts.hooks?.onTransportError?.(
      new Error(`unrecognised JSON-RPC frame: ${line.slice(0, 200)}`),
    )
  }

  private handleResponse(msg: JsonRpcResponseResult | JsonRpcResponseError): void {
    if (msg.id === null || msg.id === undefined) return
    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.pending.delete(msg.id)
    if ('error' in msg) {
      const e = new Error(`codex error ${msg.error.code}: ${msg.error.message}`)
      ;(e as Error & { rpcError?: typeof msg.error }).rpcError = msg.error
      pending.reject(e)
      return
    }
    pending.resolve(msg.result)
  }

  private async handleServerRequest(req: JsonRpcRequest): Promise<void> {
    if (isApprovalMethod(req.method)) {
      // Approval dispatch — wrap params as the adapter's typed shape and
      // call the handler. Any throw from the handler is converted into a
      // `decline` so codex unblocks instead of hanging on its end of the
      // pipe.
      const wire = {
        method: req.method,
        params: req.params,
      } as CodexApprovalWireRequest
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
        // Fail-closed: tell codex to abandon the action. `decline` is the
        // gentlest deny — keeps the turn alive so the model can react.
        this.writeFrame({
          jsonrpc: '2.0',
          id: req.id,
          result: { decision: 'decline' },
        })
      }
      return
    }

    // Non-approval server request. Caller may override; default is "method
    // not found" so codex unblocks rather than hangs.
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
