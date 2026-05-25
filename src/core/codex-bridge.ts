/**
 * Codex exec-server transport bridge (#552 PR 3).
 *
 * Thin codex-specific facade over `JsonRpcStdioBridge` — the generic
 * JSON-RPC 2.0 stdio bridge that also powers the ACP transport used
 * by Hermes / OpenClaw / ZeroClaw. CodexBridge supplies the codex
 * approval-method set + the codex-shaped fail-closed reply
 * (`{ decision: 'decline' }`); the rest of the lifecycle, framing,
 * and request/response routing lives in the generic.
 *
 * Public API (constructor, `start`, `stop`, `request`, `notify`,
 * `CodexBridgeOptions`, `CodexApprovalHandler`, etc.) is preserved
 * verbatim from the original CodexBridge implementation so existing
 * callers + tests don't change.
 *
 * Method routing (codex side) → adapter normalised:
 *
 *   item/commandExecution/requestApproval  → shell_exec
 *   item/fileChange/requestApproval        → file_write
 *   item/permissions/requestApproval       → permission_overlay
 *
 * Approval-method routing is intentionally NOT hard-coded to a
 * specific adapter. The caller supplies `onApprovalRequest(wire)`;
 * this file just provides the wire-shaped union + the codex
 * fail-closed default.
 */

import type { Readable, Writable } from 'node:stream'

import type {
  CodexApprovalMethod,
  CodexCommandExecutionRequestApprovalParams,
  CodexFileChangeRequestApprovalParams,
  CodexPermissionsRequestApprovalParams,
} from './adapters/index.js'
import {
  JsonRpcStdioBridge,
  type JsonRpcStdioBridgeHooks,
} from './jsonrpc-stdio-bridge.js'

// =============================================================================
// Public contract — preserved verbatim from the pre-refactor file so existing
// callers (codex-mediated-spawn, codex-mediator-connector, the tests) don't
// change.
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
export type CodexBridgeHooks = JsonRpcStdioBridgeHooks

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

// =============================================================================
// Approval method set — codex-specific. Kept in this file so a future
// codex protocol version (e.g. v2 adds a fourth approval method) can
// ship as a one-line catalogue change without touching the generic
// bridge.
// =============================================================================

const CODEX_APPROVAL_METHODS = new Set<CodexApprovalMethod>([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
])

// =============================================================================
// CodexBridge — thin facade
// =============================================================================

/**
 * CodexBridge is the codex-flavoured `JsonRpcStdioBridge`. Public API
 * is identical to the pre-refactor class so call sites and tests don't
 * change.
 *
 * Inheritance vs composition: extending JsonRpcStdioBridge keeps the
 * facade trivial — every method delegates directly. The generic's
 * approval-method set + fail-closed reply are bound in the constructor
 * call to `super()`.
 */
export class CodexBridge extends JsonRpcStdioBridge<
  CodexApprovalWireRequest,
  { decision: unknown }
> {
  constructor(opts: CodexBridgeOptions) {
    super({
      input: opts.input,
      output: opts.output,
      approvalMethods: CODEX_APPROVAL_METHODS,
      onApprovalRequest: opts.onApprovalRequest,
      // Codex's fail-closed: gentle deny that keeps the turn alive so
      // the model can react. ACP's equivalent is
      // `{ outcome: { outcome: 'cancelled' } }` — supplied by the ACP
      // bridge instantiation in a follow-up.
      failClosedReply: () => ({ decision: 'decline' as const }),
      hooks: opts.hooks,
      label: 'CodexBridge',
    })
  }
}
