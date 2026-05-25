/**
 * Bridge ↔ Mediator connector for ACP-mode agents.
 *
 * The ACP-side counterpart of `codex-mediator-connector.ts`. Both modules
 * compose the same pieces — adapter (#552 PR 1) + MCP-aware mediator
 * (#552 PR 2) — but route the agent-specific wire shapes for ACP's
 * `session/request_permission` instead of codex's `item/.../requestApproval`.
 *
 * The handler returned from `wireAcpBridgeToMediator()` plugs into
 * `JsonRpcStdioBridge`'s `onApprovalRequest` slot. On each approval:
 *
 *   1. Adapter decodes `session/request_permission` → `NormalisedActionRequest`.
 *      (Pulls toolCall kind + rawInput onto the canonical Foreman shape.)
 *   2. Mediator runs risk + approval (auto-allow low risk; escalate high
 *      risk through the existing chat surface).
 *   3. Adapter encodes the resolved decision into ACP's
 *      `RequestPermissionResponse` — picking the closest-match
 *      `PermissionOption` from the agent-supplied list, or
 *      `outcome: cancelled` when nothing fits.
 *
 * Fail-closed:
 *   - Adapter decode error → cancelled outcome.
 *   - Mediator throw → cancelled outcome.
 *
 * Pure orchestration — no IO, no clock. Mediator is interface-injected
 * (MediatorLike) so tests pass a doubles without booting the full
 * MediatorService.
 */

import type { JSONRPCMessage } from '../mcp/types.js'
import {
  AdapterDecodeError,
  acpStdioV1Adapter,
  type AcpPermissionOption,
  type AcpRequestPermissionResponse,
  type AcpWireRequest,
  type AcpWireResponse,
  type NormalisedActionRequest,
  type NormalisedDecision,
} from './adapters/index.js'
import type { MediatorLike } from './codex-mediator-connector.js'
import type { MediatorOutput } from './mediator.js'

/** Specific adapter shape the connector needs — the third argument
 *  to encodeDecision (the ACP-offered options list) is not part of
 *  the generic AgentAdapter interface, so we narrow here. */
interface AcpAdapter {
  readonly id: string
  readonly label: string
  decodeRequest(wire: AcpWireRequest, sourceAgent: string): NormalisedActionRequest
  encodeDecision(
    decision: NormalisedDecision,
    approvalId: string,
    availableOptions?: AcpPermissionOption[],
  ): AcpWireResponse
}

export interface WireAcpBridgeToMediatorOptions {
  /** Foreman-registered agent id (recorded on every audit row). */
  sourceAgent: string
  /** Mediator (or a test double) for risk + approval. */
  mediator: MediatorLike
  /** Adapter — defaults to `acpStdioV1Adapter`. Override only when
   *  wiring a future ACP v2 or a fixture adapter in tests. */
  adapter?: AcpAdapter
  /** Optional diagnostic sink — called with the resolved
   *  `MediatorOutput` for every approval round-trip so the spawn
   *  engine can record audit rows beyond what the mediator already
   *  persists. */
  onResolved?(output: MediatorOutput, request: AcpWireRequest): void
}

/**
 * Build the `onApprovalRequest` handler an ACP-flavoured
 * `JsonRpcStdioBridge` consumes. The handler:
 *
 *   adapter.decodeRequest → mediator.handleRequest → adapter.encodeDecision(decision, approvalId, availableOptions)
 *
 * Returns the ACP `RequestPermissionResponse` shape; the bridge
 * serialises it as the JSON-RPC result of the original
 * `session/request_permission` request.
 */
export function wireAcpBridgeToMediator(
  options: WireAcpBridgeToMediatorOptions,
): (request: AcpWireRequest) => Promise<AcpRequestPermissionResponse> {
  const adapter: AcpAdapter = options.adapter ?? (acpStdioV1Adapter as AcpAdapter)

  return async function onApprovalRequest(
    wire: AcpWireRequest,
  ): Promise<AcpRequestPermissionResponse> {
    // 1. Decode — fail-closed on malformed payload.
    let normalised
    try {
      normalised = adapter.decodeRequest(wire, options.sourceAgent)
    } catch (err) {
      // The adapter's encodeDecision wants the agent-offered options
      // to pick a matching id; on a decode failure we couldn't read
      // them, so encodeDecision returns the cancelled fail-safe.
      void err
      const encoded = adapter.encodeDecision(
        { kind: 'deny', reason: 'adapter decode failure' },
        'unknown',
      )
      return encoded.result
    }

    // 2. Build the synthetic JSON-RPC message so the mediator's
    //    existing argsFromMessage walks the right path. Same shape
    //    the codex connector uses.
    const message = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: normalised.targetTool,
        arguments: normalised.args,
      },
    } as JSONRPCMessage

    // 3. Run the mediator — wrap in try/catch for the fail-closed
    //    fallback. The mediator's own error paths return a `denied`
    //    MediatorOutput, so this catch is for unexpected throws.
    let mediatorOutput: MediatorOutput
    try {
      mediatorOutput = await options.mediator.handleRequest({
        sourceAgent: normalised.sourceAgent,
        targetTool: normalised.targetTool,
        sessionId: normalised.sessionId,
        message,
      })
    } catch (err) {
      void err
      const encoded = adapter.encodeDecision(
        { kind: 'deny', reason: 'mediator failure' },
        normalised.approvalId,
        wire.params.options,
      )
      return encoded.result
    }

    // 4. Normalised decision from MediatorOutput. Risk reasons surface
    //    as the user-facing deny reason; when the mediator denied
    //    without factors (policy match) fall back to "denied by
    //    <decidedBy>".
    const decision: NormalisedDecision =
      mediatorOutput.decision === 'allowed'
        ? { kind: 'allow' }
        : {
            kind: 'deny',
            reason:
              mediatorOutput.riskReasons?.[0] ??
              `denied by ${mediatorOutput.decidedBy}`,
          }

    // 5. ACP-specific: encoder needs the agent-offered options to pick
    //    the matching optionId. wire.params.options always carries
    //    these because the adapter's decode validates options are
    //    non-empty (throws otherwise; we returned above).
    const encoded = adapter.encodeDecision(
      decision,
      normalised.approvalId,
      wire.params.options,
    )

    options.onResolved?.(mediatorOutput, wire)
    return encoded.result
  }
}

// Re-export the type AdapterDecodeError so callers don't have to
// import it from two paths.
export { AdapterDecodeError }
