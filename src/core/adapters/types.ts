/**
 * Agent-action adapter interface (#552).
 *
 * Background — historically, Foreman's `MediatorService` consumed claude-code's
 * `PreToolUse` hook payload directly. Adding a second agent (codex via
 * `codex exec-server`) revealed that the mediator's `MediatorInput` /
 * `RiskRequest` shape was already agent-agnostic; what was missing was a named
 * seam where each agent's wire payload normalises into that shape and where
 * the mediator's resolved decision serialises back into the agent's expected
 * response shape.
 *
 * `AgentAdapter` is that seam. Each adapter owns:
 *
 *   - The agent-specific approval-request payload type (in / decode).
 *   - The agent-specific approval-response payload type (out / encode).
 *   - A small mapping function that produces the inputs Foreman's risk pipeline
 *     already understands (`sourceAgent` + `targetTool` + `args`).
 *
 * Why not invent a fat `ActionDescriptor` type in this PR — `RiskRequest`
 * already plays that role. Adding a parallel type would force a global
 * refactor of every risk rule for no immediate gain. Adapters keep the
 * change surgical: introduce the seam, document the contract, ship the
 * codex types, leave the rule corpus alone.
 *
 * Tests that exercise this interface live in `tests/core/adapters/`.
 */

import type { RiskRequest } from '../risk-rules/types.js'

/**
 * Normalised approval-request payload — the shape every adapter must
 * produce so it can flow into Foreman's existing mediator + risk pipeline.
 *
 * The fields here are a strict subset of `MediatorInput` / `RiskRequest`,
 * deliberately. Adapters do not see the mediator's wider machinery (db,
 * registry, etc.); they just translate wire bytes ↔ this shape.
 */
export interface NormalisedActionRequest {
  /** Foreman-registered id of the agent emitting this request. */
  sourceAgent: string
  /** Stable tool identifier risk rules can match against, e.g.
   *  `shell_exec`, `file_write`, `network_fetch`, `mcp_call`. Adapters MUST
   *  map their agent-native tool names onto these canonical ids so a single
   *  rule corpus serves all agents. */
  targetTool: string
  /** Tool-specific arguments. Schema depends on `targetTool`:
   *    shell_exec   → { cmd: string, cwd?: string }
   *    file_write   → { path: string, content?: string }
   *    network_fetch→ { url: string, host?: string, protocol?: string }
   *    mcp_call     → { server: string, tool: string, args: unknown }
   *  Adapters should stay in this lane so rules don't grow per-agent
   *  branches. */
  args: Record<string, unknown>
  /** Opaque approval id supplied by the agent. When the mediator needs to
   *  respond asynchronously (high-risk → human prompt → resume), it pairs
   *  the resolved decision with this id so the adapter can route the
   *  response to the right pending request. */
  approvalId: string
  /** Optional agent-side session/thread correlator. Adapters surface it so
   *  loop-detection + audit can chain actions per session. */
  sessionId?: string
  /** Optional human-readable reason carried in the agent's payload. Stored
   *  on the audit row so investigations don't have to re-derive intent. */
  reason?: string
}

/**
 * Universal decision shape produced by Foreman's approval pipeline. Adapters
 * encode this into whatever the agent's wire protocol expects.
 *
 * Designed so the union is a small open set Foreman owns. Codex's richer
 * decision space (`acceptForSession`, execpolicy / network amendments) maps
 * onto these via the adapter; claude-code's allow/deny similarly. New
 * decision types are added here first, then adapters update.
 */
export type NormalisedDecision =
  | { kind: 'allow' }
  /** Allow + remember for the rest of the agent's session (maps to codex's
   *  `acceptForSession`; claude-code adapter stores it in its own
   *  remember-cache). */
  | { kind: 'allow_for_session' }
  /** Deny but let the agent continue the turn (codex `decline` /
   *  claude-code deny without interruption). */
  | { kind: 'deny'; reason: string }
  /** Deny AND interrupt the current turn (codex `cancel`; claude-code may
   *  short-circuit the turn or surface a system message). */
  | { kind: 'deny_and_interrupt'; reason: string }

/**
 * The contract every per-agent adapter implements. Generic over the agent's
 * own wire types so adapters get full static typing of their native
 * payloads while exposing only the normalised shapes to Foreman.
 *
 * Adapters are pure mapping functions — no IO, no DB, no clock. Side-effecting
 * concerns (writing to `pending_approvals`, polling chat) live in the
 * mediator / approval service. Keeping adapters pure makes them trivially
 * unit-testable and lets the same adapter serve both the production path and
 * fixture-driven tests.
 */
export interface AgentAdapter<TWireRequest = unknown, TWireResponse = unknown> {
  /** Stable id used in `registry/agents.json` `approval_adapter` and in
   *  log lines. Convention: `<agent>-<surface>-<version>` so a future
   *  v2 can coexist with v1 during a migration. */
  readonly id: string
  /** Friendly label for TUI / docs. */
  readonly label: string

  /**
   * Translate the agent's native approval-request payload into the
   * normalised shape Foreman's risk + approval pipeline consumes.
   *
   * Implementations MAY throw `AdapterDecodeError` (below) when the payload
   * is malformed — the caller treats that as a fail-closed deny.
   */
  decodeRequest(wire: TWireRequest, sourceAgent: string): NormalisedActionRequest

  /**
   * Translate Foreman's resolved decision into the wire shape the agent
   * expects for the matching response. The `approvalId` is included so
   * adapters that need it (e.g. JSON-RPC `id` round-tripping) have it
   * without re-parsing.
   */
  encodeDecision(decision: NormalisedDecision, approvalId: string): TWireResponse

  /**
   * Helper that converts a normalised request into the `RiskRequest` shape
   * the risk scorer evaluates. Default in `defaultRiskRequest()` below;
   * adapters override only when they need to inject agent-specific extra
   * context (e.g. claude-code's tool_input.command needs unwrapping into
   * `args.cmd`).
   */
  toRiskRequest?(normalised: NormalisedActionRequest): RiskRequest
}

/** Default mapping — most adapters need nothing more than this. */
export function defaultRiskRequest(n: NormalisedActionRequest): RiskRequest {
  return {
    sourceAgent: n.sourceAgent,
    targetTool: n.targetTool,
    args: n.args,
    sessionId: n.sessionId,
  }
}

/** Thrown by adapters when the wire payload can't be decoded. The mediator
 *  treats this as a fail-closed deny so a broken adapter does not silently
 *  let actions through. */
export class AdapterDecodeError extends Error {
  constructor(
    public readonly adapterId: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${adapterId}] ${message}`)
    this.name = 'AdapterDecodeError'
  }
}
