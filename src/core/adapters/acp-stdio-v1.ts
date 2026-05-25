/**
 * Adapter: agents that speak the Agent Client Protocol over stdio.
 *
 * Targets Hermes (`hermes acp`), OpenClaw (`openclaw acp`), ZeroClaw
 * (`zeroclaw acp`), and any future ACP-compatible agent. Codex stays on
 * its own `codex-exec-server-v1` adapter because its protocol predates
 * ACP and uses different method names; that's two adapters for the
 * same underlying transport pattern (JSON-RPC 2.0 over stdio).
 *
 * Scope:
 *
 *   - Decodes `session/request_permission` server-requests into the
 *     adapter-neutral `NormalisedActionRequest`.
 *   - Encodes Foreman's `NormalisedDecision` back into ACP's
 *     `RequestPermissionResponse` by picking the closest-match
 *     `PermissionOption` from the agent-supplied list.
 *   - Carries no other ACP methods (fs/*, terminal/*, session/update
 *     notifications) — those land in the spawn helper / bridge in a
 *     follow-up PR.
 *
 * Why the agent supplies the options:
 *
 *   ACP lets the agent declare which choices it considers valid for
 *   THIS specific call. Most calls offer the canonical 4 (allow_once,
 *   allow_always, reject_once, reject_always); some offer subsets
 *   (e.g. read-only ops might omit `_always` variants). The adapter's
 *   encoder must pick from what was offered, falling back to
 *   `cancelled` when nothing matches.
 *
 * Decision mapping (Foreman → ACP option kind):
 *
 *   allow              → allow_once
 *   allow_for_session  → allow_always
 *   deny               → reject_once
 *   deny_and_interrupt → reject_once + (caller emits session/cancel
 *                        separately if it wants an immediate stop;
 *                        for now we collapse onto reject_once)
 */

import {
  AdapterDecodeError,
  type AgentAdapter,
  type NormalisedActionRequest,
  type NormalisedDecision,
} from './types.js'
import type {
  AcpPermissionOption,
  AcpRequestPermissionParams,
  AcpRequestPermissionResponse,
  AcpToolCall,
} from './acp-approval-types.js'

const ADAPTER_ID = 'acp-stdio-v1'

// =============================================================================
// Wire request / response — tagged unions the transport layer routes on
// =============================================================================

export type AcpWireRequest = {
  method: 'session/request_permission'
  params: AcpRequestPermissionParams
}

export type AcpWireResponse = {
  method: 'session/request_permission'
  result: AcpRequestPermissionResponse
}

// =============================================================================
// decodeRequest — ACP → normalised
// =============================================================================

/**
 * Pull a canonical Foreman targetTool from ACP's tool-call kind. Falls
 * back to a lower-cased pass-through for `think` / `search` / `other`
 * because risk rules ignore those (they're agent-internal); the
 * normalised shape stays clean either way.
 */
function targetToolFor(kind: AcpToolCall['kind']): string {
  switch (kind) {
    case 'execute':
      return 'shell_exec'
    case 'edit':
    case 'delete':
    case 'move':
      return 'file_write'
    case 'fetch':
      return 'network_fetch'
    case 'read':
      return 'read'
    case undefined:
    case 'search':
    case 'think':
    case 'other':
    default:
      return typeof kind === 'string' ? kind : 'other'
  }
}

/**
 * Pull the shell command / file path / URL out of the tool-call's
 * raw input depending on its kind. ACP doesn't standardise rawInput's
 * shape — agents pick their own keys — so we probe the common ones
 * and surface whatever we find on the normalised args.
 */
function argsFor(tool: AcpToolCall): Record<string, unknown> {
  const raw = (tool.rawInput ?? {}) as Record<string, unknown>
  const args: Record<string, unknown> = {}
  const firstLocation = tool.locations?.[0]?.path

  // shell — common keys agents use: command, cmd, script.
  if (tool.kind === 'execute') {
    const cmd =
      typeof raw.command === 'string'
        ? raw.command
        : typeof raw.cmd === 'string'
          ? raw.cmd
          : typeof raw.script === 'string'
            ? raw.script
            : tool.title // best-effort fallback so risk rules see SOMETHING
    args.cmd = cmd
    if (typeof raw.cwd === 'string') args.cwd = raw.cwd
    return args
  }

  // file_write — locations[0].path is canonical; rawInput.path /
  // rawInput.file_path are common alternatives.
  if (
    tool.kind === 'edit' ||
    tool.kind === 'delete' ||
    tool.kind === 'move'
  ) {
    const path =
      firstLocation ??
      (typeof raw.path === 'string'
        ? raw.path
        : typeof raw.file_path === 'string'
          ? raw.file_path
          : '')
    args.path = path
    if (Array.isArray(tool.locations)) {
      args.paths = tool.locations
        .map((l) => l.path)
        .filter((p): p is string => typeof p === 'string')
    }
    args.kind = tool.kind
    return args
  }

  // network_fetch — `url` is the canonical key.
  if (tool.kind === 'fetch') {
    if (typeof raw.url === 'string') args.url = raw.url
    if (typeof raw.method === 'string') args.method = raw.method
    return args
  }

  // Everything else — pass rawInput through unchanged so a future
  // risk rule that opts into reading raw shape still works.
  return { ...raw }
}

function decodeRequestPermission(
  params: AcpRequestPermissionParams,
  sourceAgent: string,
): NormalisedActionRequest {
  if (typeof params.sessionId !== 'string' || params.sessionId.length === 0) {
    throw new AdapterDecodeError(
      ADAPTER_ID,
      'RequestPermissionParams.sessionId is required',
    )
  }
  if (
    !params.toolCall ||
    typeof params.toolCall.toolCallId !== 'string' ||
    params.toolCall.toolCallId.length === 0
  ) {
    throw new AdapterDecodeError(
      ADAPTER_ID,
      'RequestPermissionParams.toolCall.toolCallId is required',
    )
  }
  if (!Array.isArray(params.options) || params.options.length === 0) {
    throw new AdapterDecodeError(
      ADAPTER_ID,
      'RequestPermissionParams.options must be a non-empty array',
    )
  }
  return {
    sourceAgent,
    targetTool: targetToolFor(params.toolCall.kind),
    args: argsFor(params.toolCall),
    approvalId: params.toolCall.toolCallId,
    sessionId: params.sessionId,
    reason: params.toolCall.title,
  }
}

// =============================================================================
// encodeDecision — normalised → ACP option pick
// =============================================================================

/**
 * Pick the best-matching option from the agent's offered list.
 * Strategy:
 *   1. Exact kind match (allow_once / allow_always / reject_once /
 *      reject_always).
 *   2. Family fallback (any allow_* for an allow-shaped decision; any
 *      reject_* for a deny-shaped decision).
 *   3. Otherwise null — caller switches to `outcome: cancelled`.
 */
function pickOptionFor(
  decision: NormalisedDecision,
  options: AcpPermissionOption[],
): AcpPermissionOption | null {
  const targetKind =
    decision.kind === 'allow'
      ? 'allow_once'
      : decision.kind === 'allow_for_session'
        ? 'allow_always'
        : decision.kind === 'deny'
          ? 'reject_once'
          : 'reject_once' // deny_and_interrupt collapses onto reject_once
  // 1. Exact.
  const exact = options.find((o) => o.kind === targetKind)
  if (exact) return exact
  // 2. Family.
  if (decision.kind === 'allow' || decision.kind === 'allow_for_session') {
    const fallback = options.find((o) => o.kind.startsWith('allow'))
    if (fallback) return fallback
  } else {
    const fallback = options.find((o) => o.kind.startsWith('reject'))
    if (fallback) return fallback
  }
  return null
}

// =============================================================================
// Adapter
// =============================================================================

class AcpStdioV1Adapter implements AgentAdapter<AcpWireRequest, AcpWireResponse> {
  readonly id = ADAPTER_ID
  readonly label = 'ACP agents (JSON-RPC stdio)'

  decodeRequest(
    wire: AcpWireRequest,
    sourceAgent: string,
  ): NormalisedActionRequest {
    switch (wire.method) {
      case 'session/request_permission':
        return decodeRequestPermission(wire.params, sourceAgent)
    }
  }

  /**
   * Encode the resolved decision as an ACP RequestPermissionResponse.
   * The transport layer remembers which options the agent offered for
   * the in-flight call and passes them through `availableOptions` so
   * the encoder can pick the right `optionId`. When omitted (the
   * shape is symmetric with codexExecServerV1Adapter.encodeDecision
   * but the ACP variant genuinely needs the options to pick from), we
   * emit `outcome: cancelled` as the fail-safe.
   */
  encodeDecision(
    decision: NormalisedDecision,
    approvalId: string,
    availableOptions?: AcpPermissionOption[],
  ): AcpWireResponse {
    void approvalId
    if (!availableOptions || availableOptions.length === 0) {
      return {
        method: 'session/request_permission',
        result: { outcome: { outcome: 'cancelled' } },
      }
    }
    const picked = pickOptionFor(decision, availableOptions)
    if (!picked) {
      return {
        method: 'session/request_permission',
        result: { outcome: { outcome: 'cancelled' } },
      }
    }
    return {
      method: 'session/request_permission',
      result: {
        outcome: { outcome: 'selected', optionId: picked.optionId },
      },
    }
  }
}

export const acpStdioV1Adapter: AgentAdapter<
  AcpWireRequest,
  AcpWireResponse
> = new AcpStdioV1Adapter()
