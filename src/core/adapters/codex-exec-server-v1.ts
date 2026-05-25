/**
 * Adapter: codex via `codex exec-server --listen stdio` (#552).
 *
 * Decodes codex's JSON-RPC approval requests into Foreman's normalised
 * shape and encodes Foreman's resolved decisions back into codex's wire
 * variants. This file is the deliberate "thin seam" — no IO, no client
 * lifecycle, no transport handling. Transport + JSON-RPC framing lands in
 * a follow-up PR (#552 PR 3); this PR ships the encoding contract first
 * so the rest of the pipeline can be built against a stable interface.
 *
 * Method routing (codex side) → normalised (`targetTool`):
 *
 *   item/commandExecution/requestApproval  → shell_exec
 *   item/fileChange/requestApproval        → file_write
 *   item/permissions/requestApproval       → permission_overlay
 *
 * Decision mapping (Foreman → codex):
 *
 *   allow                → accept
 *   allow_for_session    → acceptForSession
 *   deny                 → decline
 *   deny_and_interrupt   → cancel
 *
 * The richer codex variants — `acceptWithExecpolicyAmendment`,
 * `applyNetworkPolicyAmendment` — are not yet emitted by Foreman's approval
 * pipeline; the matching codex-side response variants stay reachable
 * through `encodeRawDecision()` below so future Foreman-side learnings
 * can target them without changing this adapter's public contract.
 */

import {
  AdapterDecodeError,
  type AgentAdapter,
  type NormalisedActionRequest,
  type NormalisedDecision,
} from './types.js'
import type {
  CodexApprovalMethod,
  CodexCommandExecutionApprovalDecision,
  CodexCommandExecutionRequestApprovalParams,
  CodexCommandExecutionRequestApprovalResponse,
  CodexFileChangeApprovalDecision,
  CodexFileChangeRequestApprovalParams,
  CodexFileChangeRequestApprovalResponse,
  CodexPermissionsApprovalDecision,
  CodexPermissionsRequestApprovalParams,
  CodexPermissionsRequestApprovalResponse,
} from './codex-approval-types.js'

const ADAPTER_ID = 'codex-exec-server-v1'

/**
 * Tagged input that the JSON-RPC dispatcher passes into the adapter. The
 * transport layer (lands in PR 3) is responsible for routing on `method` and
 * narrowing the params accordingly; this lets the adapter stay focused on
 * the encode/decode contract without re-implementing JSON-RPC parsing.
 */
export type CodexWireRequest =
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
 * Mirrors `CodexWireRequest` for the response side. The adapter's
 * `encodeDecision` produces this, the transport layer wraps it back into a
 * JSON-RPC `result` keyed by the original request id.
 */
export type CodexWireResponse =
  | {
      method: 'item/commandExecution/requestApproval'
      result: CodexCommandExecutionRequestApprovalResponse
    }
  | {
      method: 'item/fileChange/requestApproval'
      result: CodexFileChangeRequestApprovalResponse
    }
  | {
      method: 'item/permissions/requestApproval'
      result: CodexPermissionsRequestApprovalResponse
    }

// =============================================================================
// decodeRequest — codex wire → normalised
// =============================================================================

function decodeCommandExecution(
  params: CodexCommandExecutionRequestApprovalParams,
  sourceAgent: string,
): NormalisedActionRequest {
  if (typeof params.itemId !== 'string' || params.itemId.length === 0) {
    throw new AdapterDecodeError(
      ADAPTER_ID,
      'CommandExecutionRequestApprovalParams.itemId is required',
    )
  }
  return {
    sourceAgent,
    targetTool: 'shell_exec',
    args: {
      cmd: params.command ?? '',
      cwd: params.cwd ?? undefined,
      networkHost: params.networkApprovalContext?.host,
      networkProtocol: params.networkApprovalContext?.protocol,
    },
    // For zsh-exec-bridge multi-callback approvals codex disambiguates with
    // `approvalId`; the parent `itemId` alone wouldn't route correctly.
    // Fall back to `itemId` otherwise.
    approvalId: params.approvalId ?? params.itemId,
    sessionId: params.threadId,
    reason: params.reason ?? undefined,
  }
}

function decodeFileChange(
  params: CodexFileChangeRequestApprovalParams,
  sourceAgent: string,
): NormalisedActionRequest {
  if (typeof params.itemId !== 'string' || params.itemId.length === 0) {
    throw new AdapterDecodeError(
      ADAPTER_ID,
      'FileChangeRequestApprovalParams.itemId is required',
    )
  }
  // Pick the first changed path as the canonical `args.path` so existing
  // path-shaped rules see something. Multi-change batches surface as
  // `args.paths` so a future rule can fan out over them without breaking
  // single-path rules.
  const paths = (params.changes ?? []).map((c) => c.path).filter((p) => p.length > 0)
  return {
    sourceAgent,
    targetTool: 'file_write',
    args: {
      path: paths[0] ?? '',
      paths,
      kinds: (params.changes ?? []).map((c) => c.kind),
    },
    approvalId: params.itemId,
    sessionId: params.threadId,
    reason: params.reason ?? undefined,
  }
}

function decodePermissions(
  params: CodexPermissionsRequestApprovalParams,
  sourceAgent: string,
): NormalisedActionRequest {
  if (typeof params.itemId !== 'string' || params.itemId.length === 0) {
    throw new AdapterDecodeError(
      ADAPTER_ID,
      'PermissionsRequestApprovalParams.itemId is required',
    )
  }
  return {
    sourceAgent,
    targetTool: 'permission_overlay',
    args: {
      cwd: params.cwd,
      // Pass the raw permissions blob through; rules that opt into reading
      // the overlay can introspect it. Keeping it as `unknown` here avoids
      // false confidence in a schema that's still in flux upstream.
      permissions: params.permissions,
    },
    approvalId: params.itemId,
    sessionId: params.threadId,
  }
}

// =============================================================================
// encodeDecision — normalised → codex wire
// =============================================================================

function commandExecutionFor(
  decision: NormalisedDecision,
): CodexCommandExecutionApprovalDecision {
  switch (decision.kind) {
    case 'allow':
      return 'accept'
    case 'allow_for_session':
      return 'acceptForSession'
    case 'deny':
      return 'decline'
    case 'deny_and_interrupt':
      return 'cancel'
  }
}

function fileChangeFor(decision: NormalisedDecision): CodexFileChangeApprovalDecision {
  switch (decision.kind) {
    case 'allow':
    case 'allow_for_session':
      // FileChange has no session variant in codex's schema; an "allow +
      // remember" maps to a plain accept and the remember-cache is
      // Foreman-side.
      return 'accept'
    case 'deny':
      return 'decline'
    case 'deny_and_interrupt':
      return 'cancel'
  }
}

function permissionsFor(decision: NormalisedDecision): CodexPermissionsApprovalDecision {
  switch (decision.kind) {
    case 'allow':
    case 'allow_for_session':
      return 'accept'
    case 'deny':
      return 'decline'
    case 'deny_and_interrupt':
      return 'cancel'
  }
}

// =============================================================================
// Adapter object
// =============================================================================

class CodexExecServerV1Adapter
  implements AgentAdapter<CodexWireRequest, CodexWireResponse>
{
  readonly id = ADAPTER_ID
  readonly label = 'Codex (exec-server JSON-RPC)'

  decodeRequest(wire: CodexWireRequest, sourceAgent: string): NormalisedActionRequest {
    switch (wire.method) {
      case 'item/commandExecution/requestApproval':
        return decodeCommandExecution(wire.params, sourceAgent)
      case 'item/fileChange/requestApproval':
        return decodeFileChange(wire.params, sourceAgent)
      case 'item/permissions/requestApproval':
        return decodePermissions(wire.params, sourceAgent)
    }
  }

  /**
   * The adapter needs to know which codex method to encode the response for.
   * The transport layer remembers this per pending-request and passes the
   * stashed `method` through the optional second argument; when omitted we
   * default to commandExecution (the most common case) so unit tests over
   * the basic encode path stay terse.
   */
  encodeDecision(
    decision: NormalisedDecision,
    approvalId: string,
    method: CodexApprovalMethod = 'item/commandExecution/requestApproval',
  ): CodexWireResponse {
    // approvalId is currently unused on the encode side (codex pairs the
    // response with the JSON-RPC `id` at the transport layer, not on the
    // decision payload itself). Kept on the signature for symmetry with
    // future adapters whose response shape includes the id.
    void approvalId

    switch (method) {
      case 'item/commandExecution/requestApproval':
        return {
          method,
          result: { decision: commandExecutionFor(decision) },
        }
      case 'item/fileChange/requestApproval':
        return {
          method,
          result: { decision: fileChangeFor(decision) },
        }
      case 'item/permissions/requestApproval':
        return {
          method,
          result: { decision: permissionsFor(decision) },
        }
    }
  }
}

export const codexExecServerV1Adapter: AgentAdapter<
  CodexWireRequest,
  CodexWireResponse
> = new CodexExecServerV1Adapter()
