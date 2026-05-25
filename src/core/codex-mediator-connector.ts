/**
 * Bridge ↔ Mediator connector (#552 PR 4).
 *
 * Glues `CodexBridge` (PR 3) to Foreman's adapter + mediator pipeline so a
 * single function — `wireBridgeToMediator` — produces the
 * `onApprovalRequest` callback the bridge expects. The actual JSON-RPC
 * protocol stays in the bridge; the actual risk + approval flow stays in
 * the mediator; this module is the wiring between them.
 *
 * Why a separate file: the spawn engine (PR 4 hookup point) needs a
 * one-liner to drop into the bridge constructor. Keeping the wiring as a
 * pure factory (no IO, no side effects beyond delegating to its
 * dependencies) means we can unit-test it against the in-memory bridge
 * harness from PR 3 + a stubbed mediator from the existing mcp-stdio
 * tests, without booting a real codex process.
 *
 * Mediator coupling is by interface — the connector accepts an object
 * with `handleRequest(...)` so callers can pass either the full
 * `MediatorService` instance or a test double.
 */

import type { JSONRPCMessage } from '../mcp/types.js'
import {
  AdapterDecodeError,
  codexExecServerV1Adapter,
  type AgentAdapter,
  type CodexWireRequest,
  type CodexWireResponse,
  type NormalisedDecision,
} from './adapters/index.js'
import type { CodexApprovalHandler, CodexApprovalWireRequest } from './codex-bridge.js'
import type { MediatorInput, MediatorOutput } from './mediator.js'

/** Slim subset of `MediatorService` the connector actually calls. */
export interface MediatorLike {
  handleRequest(input: MediatorInput): Promise<MediatorOutput>
}

export interface WireBridgeToMediatorOptions {
  /** Foreman-registered agent id (recorded on every audit row). */
  sourceAgent: string
  /** Mediator (or a test double) for risk + approval. */
  mediator: MediatorLike
  /** Adapter — defaults to `codexExecServerV1Adapter` since the bridge is
   *  codex-specific. Override only when wiring a future v2 or a fixture
   *  adapter in tests. */
  adapter?: AgentAdapter<CodexWireRequest, CodexWireResponse>
  /** Optional diagnostic sink — called with the resolved `MediatorOutput`
   *  for every approval round-trip so the spawn engine can record audit
   *  rows beyond what the mediator already persists. */
  onResolved?(output: MediatorOutput, request: CodexApprovalWireRequest): void
}

/**
 * Return a `CodexApprovalHandler` that the bridge can drop into its
 * `onApprovalRequest` slot. The handler:
 *
 *   1. Asks the adapter to decode the codex wire payload into a
 *      `NormalisedActionRequest`.
 *   2. Constructs a synthetic JSON-RPC tools/call so the mediator's
 *      `argsFromMessage` parses the args exactly as it would for a real
 *      claude-code request (no mediator changes needed).
 *   3. Runs the mediator → gets allowed/denied + risk metadata.
 *   4. Maps that decision onto the adapter's typed `NormalisedDecision`
 *      and asks the adapter to encode it back into codex's wire shape.
 *   5. Returns `{ decision }` — the bridge writes this as the JSON-RPC
 *      result and codex unblocks.
 *
 * Fail-closed paths:
 *
 *   - Adapter decode error → `decline` (we don't know what the action was;
 *     refuse).
 *   - Mediator throw → `decline` (mediator should never throw, but if its
 *     dependencies are wedged we still want codex to unblock).
 */
export function wireBridgeToMediator(
  options: WireBridgeToMediatorOptions,
): CodexApprovalHandler {
  const adapter = options.adapter ?? codexExecServerV1Adapter

  return async function onApprovalRequest(
    wire: CodexApprovalWireRequest,
  ): Promise<{ decision: unknown }> {
    // 1. Decode — fail-closed on malformed payload.
    let normalised
    try {
      normalised = adapter.decodeRequest(wire as CodexWireRequest, options.sourceAgent)
    } catch (err) {
      const reason =
        err instanceof AdapterDecodeError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'adapter decode failure'
      const encoded = adapter.encodeDecision({ kind: 'deny', reason }, 'unknown')
      // The codex JSON-RPC response shape is `{ result: { decision: ... } }`;
      // `encodeDecision` returns `{ method, result: { decision } }`. The
      // bridge wraps our return value as `{ result: <returned-value> }` so
      // we strip back down to the inner `result` here.
      return { decision: pickWireDecision(encoded) }
    }

    // 2. Build a synthetic JSON-RPC message so the mediator's existing
    //    argsFromMessage walks the right path.
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
      const reason = err instanceof Error ? err.message : 'mediator failure'
      const encoded = adapter.encodeDecision({ kind: 'deny', reason }, 'unknown')
      return { decision: pickWireDecision(encoded) }
    }

    // 4. Normalised decision from MediatorOutput. Risk reasons surface as
    //    the user-facing deny message; when the mediator denied without
    //    factors (policy match) fall back to "denied by <decidedBy>" so
    //    the agent still gets context.
    const decision: NormalisedDecision =
      mediatorOutput.decision === 'allowed'
        ? { kind: 'allow' }
        : {
            kind: 'deny',
            reason:
              mediatorOutput.riskReasons?.[0] ??
              `denied by ${mediatorOutput.decidedBy}`,
          }

    // 5. Adapter encodes back to codex's wire shape, then we extract just
    //    the `result` portion the bridge will serialise.
    const encoded = adapter.encodeDecision(decision, normalised.approvalId)
    options.onResolved?.(mediatorOutput, wire)
    return { decision: pickWireDecision(encoded) }
  }
}

/**
 * Pull the inner `decision` field out of the adapter's `{method, result}`
 * envelope. The bridge owns the JSON-RPC `id` (it routes by id) and just
 * needs the `result` payload; for codex's approval methods that's
 * `{ decision: ... }`.
 */
function pickWireDecision(encoded: CodexWireResponse): unknown {
  return encoded.result.decision
}
