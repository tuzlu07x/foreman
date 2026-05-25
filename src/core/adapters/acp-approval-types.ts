/**
 * Wire types for the Agent Client Protocol (ACP) approval surface.
 *
 * ACP is the cross-vendor JSON-RPC 2.0 over stdio standard created by Zed
 * Industries (Aug 2025) — by March 2026 it's the convergence point for
 * 25+ agents including Hermes, OpenClaw, and ZeroClaw. Codex predates
 * the standardisation but its `exec-server` protocol is structurally
 * identical at the JSON-RPC layer.
 *
 * This file declares the wire shapes for the methods this adapter
 * needs:
 *
 *   - `session/request_permission` — server→client request the agent
 *     emits when a tool call needs user authorisation. Carries a
 *     `toolCall` describing what's about to run + a list of
 *     `PermissionOption`s the agent considers acceptable answers.
 *
 *   - Notifications + other server requests (fs/read_text_file,
 *     terminal/create, session/update, …) are documented in the spec
 *     but out of scope for the initial adapter — the spawn / bridge
 *     wiring picks those up in a follow-up.
 *
 * Source: https://agentclientprotocol.com/protocol/schema.md +
 *         https://agentclientprotocol.com/protocol/tool-calls.md
 */

// =============================================================================
// PermissionOption — agent-supplied response choices
// =============================================================================

/**
 * ACP categorises the 4 standard permission choices via `kind` so the
 * adapter can map Foreman's `NormalisedDecision` onto whichever
 * specific option an agent offered for this call. Agents are free to
 * supply a subset (e.g. only `allow_once` + `reject_once` for a
 * read-only operation), so encode() picks the closest match.
 */
export type AcpPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always'

export interface AcpPermissionOption {
  /** Opaque id the client returns in `selected.optionId`. */
  optionId: string
  /** Human-readable label, e.g. "Allow once", "Reject + remember". */
  name: string
  kind: AcpPermissionOptionKind
}

// =============================================================================
// ToolCall — what the agent is about to do
// =============================================================================

/**
 * ACP's `kind` enum tells the client what category of operation is
 * pending. The adapter normalises these onto Foreman's canonical
 * tool ids:
 *
 *   execute        → shell_exec
 *   edit/delete/move → file_write
 *   fetch          → network_fetch
 *   read           → read (read-only ops — rarely flagged by risk rules
 *                          today but the canonical id is reserved)
 *   search/think/other → passed through lower-cased
 */
export type AcpToolCallKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'other'

export type AcpToolCallStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'

export interface AcpToolCallLocation {
  /** Absolute file path the tool reads / writes. ACP spec allows
   *  additional fields; we read only what risk rules need. */
  path?: string
  [extra: string]: unknown
}

export interface AcpToolCall {
  /** Unique within the session. Used as the approvalId on Foreman's
   *  side so a multi-callback approval routes correctly. */
  toolCallId: string
  /** Human-readable summary the agent thought up — useful for the
   *  modal subtitle when we surface the approval to the operator. */
  title: string
  kind?: AcpToolCallKind
  status?: AcpToolCallStatus
  /** Files touched by this tool call. We pick the first when
   *  populating the normalised `args.path`. */
  locations?: AcpToolCallLocation[]
  /** Raw tool parameters — adapter inspects this to pull out the
   *  shell command / URL / file content depending on `kind`. ACP
   *  doesn't constrain `rawInput`'s shape; we typecheck per-key. */
  rawInput?: Record<string, unknown>
  /** Other fields (content[], rawOutput, …) exist in the spec but
   *  the adapter doesn't consume them today; they pass through as
   *  `raw` on the normalised request for audit. */
  [extra: string]: unknown
}

// =============================================================================
// Request / response shapes
// =============================================================================

export interface AcpRequestPermissionParams {
  sessionId: string
  toolCall: AcpToolCall
  /** Ordered list of options the agent considers valid responses.
   *  The adapter maps Foreman's decision onto whichever option's
   *  `kind` is the best match. */
  options: AcpPermissionOption[]
}

/**
 * Discriminated union: the client either picks an option or signals
 * cancellation. ACP uses `outcome` as the tag.
 */
export type AcpRequestPermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' }

export interface AcpRequestPermissionResponse {
  /** Spec nests the discriminated union under `outcome` rather than
   *  spreading at the top level; mirror that here so JSON.stringify
   *  produces the exact wire shape without extra wrapping. */
  outcome: AcpRequestPermissionOutcome
}

// =============================================================================
// Method names — kept as a const tuple so the adapter switch is
// exhaustive and a future addition (e.g. fs/write_text_file approval
// gating, if we choose to mediate file ops at this layer) gets caught
// at compile time.
// =============================================================================

export const ACP_APPROVAL_METHODS = [
  'session/request_permission',
] as const

export type AcpApprovalMethod = (typeof ACP_APPROVAL_METHODS)[number]
