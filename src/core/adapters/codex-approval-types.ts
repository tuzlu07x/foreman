/**
 * Wire types for codex's `exec-server` JSON-RPC approval surface (#552).
 *
 * Source of truth: the JSON Schema bundle produced by
 *   `codex app-server generate-json-schema --out <dir> --experimental`
 * against codex v0.133.0. Kept here as hand-written TypeScript rather than
 * codegen so adapter code can take selective dependencies (we only need the
 * approval surface; the full schema covers ~45 unrelated methods). When
 * codex's schema shifts, update this file + the adapter side-by-side and
 * lean on the unit tests to catch drift early.
 *
 * Naming preserves codex's wire names (camelCase, `decision.behavior`
 * variants) so this file is greppable against the upstream schema files.
 */

// =============================================================================
// Decision unions
// =============================================================================

/**
 * Codex's decision space for `item/commandExecution/requestApproval`. Richer
 * than claude-code's allow/deny; the adapter is responsible for mapping
 * Foreman's normalised decision onto one of these variants.
 *
 *   accept                            — one-off allow
 *   acceptForSession                  — allow + cache for the agent session
 *   acceptWithExecpolicyAmendment     — allow + persist a policy amendment
 *                                       so future matching commands skip
 *                                       the approval flow entirely
 *   applyNetworkPolicyAmendment       — allow/deny host persistently
 *   decline                           — deny, agent keeps the turn going
 *   cancel                            — deny + interrupt the turn
 */
export type CodexCommandExecutionApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | {
      acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] }
    }
  | {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: {
          action: 'allow' | 'deny'
          host: string
        }
      }
    }

/**
 * Codex's decision space for `item/fileChange/requestApproval`. Narrower —
 * file changes don't carry policy-amendment knobs the way command exec does.
 */
export type CodexFileChangeApprovalDecision = 'accept' | 'decline' | 'cancel'

/**
 * Codex's decision space for `item/permissions/requestApproval`. Used when
 * the agent asks for a sandbox-escape overlay (extra fs paths, network on,
 * etc.); usually surfaces as a separate prompt before the actual command.
 */
export type CodexPermissionsApprovalDecision = 'accept' | 'decline' | 'cancel'

// =============================================================================
// Best-effort parsed command actions — purely for friendly display in the
// approval surface. Risk rules ignore these; they reason about `command`.
// =============================================================================

export type CodexCommandAction =
  | { type: 'read'; command: string; name: string; path: string }
  | { type: 'listFiles'; command: string; path?: string | null }
  | { type: 'search'; command: string; path?: string | null; query?: string | null }
  | { type: 'unknown'; command: string }

// =============================================================================
// Network + permission overlays carried on certain approval requests
// =============================================================================

export interface CodexNetworkApprovalContext {
  host: string
  protocol: 'http' | 'https' | 'socks5Tcp' | 'socks5Udp'
}

export interface CodexAdditionalNetworkPermissions {
  enabled?: boolean | null
}

export interface CodexNetworkPolicyAmendment {
  action: 'allow' | 'deny'
  host: string
}

// File system overlay omitted from this initial cut — the adapter only
// surfaces network amendments today. When file-system overlay support lands
// (PR 4 / E2E), extend this file with the matching types.

// =============================================================================
// Request params (codex → Foreman)
// =============================================================================

/**
 * Sent on JSON-RPC method `item/commandExecution/requestApproval`. The
 * adapter normalises this into a `NormalisedActionRequest` with
 * `targetTool: 'shell_exec'` so existing shell-pattern rules fire.
 */
export interface CodexCommandExecutionRequestApprovalParams {
  itemId: string
  threadId: string
  turnId: string
  startedAtMs: number
  command: string | null
  cwd: string | null
  reason: string | null
  commandActions: CodexCommandAction[] | null
  networkApprovalContext: CodexNetworkApprovalContext | null
  additionalPermissions: {
    network?: CodexAdditionalNetworkPermissions | null
    /** fileSystem overlay — present in the schema, surfaced in a follow-up
     *  PR. Kept as `unknown` for now so this file does not pretend to model
     *  what the adapter does not yet read. */
    fileSystem?: unknown | null
  } | null
  availableDecisions: CodexCommandExecutionApprovalDecision[] | null
  proposedExecpolicyAmendment: string[] | null
  proposedNetworkPolicyAmendments: CodexNetworkPolicyAmendment[] | null
  /** For zsh-exec-bridge subcommand approvals (multiple callbacks under one
   *  parent itemId). Null for the common case. */
  approvalId: string | null
}

export interface CodexFileChangeRequestApprovalParams {
  itemId: string
  threadId: string
  turnId: string
  reason: string | null
  /** Codex's schema models `changes` as an array of (path, kind, content)
   *  triples. Kept loose here until the adapter actually inspects them; the
   *  follow-up PR that wires file-write risk rules will tighten this. */
  changes?: Array<{ path: string; kind: 'add' | 'modify' | 'delete' }> | null
}

export interface CodexPermissionsRequestApprovalParams {
  itemId: string
  threadId: string
  turnId: string
  startedAtMs: number
  cwd: string
  /** Permission overlay the agent is requesting. Modelled as `unknown` in
   *  this cut — the adapter doesn't yet route permissions overlays
   *  through risk rules. */
  permissions: unknown
}

// =============================================================================
// Response shapes (Foreman → codex)
// =============================================================================

export interface CodexCommandExecutionRequestApprovalResponse {
  decision: CodexCommandExecutionApprovalDecision
}

export interface CodexFileChangeRequestApprovalResponse {
  decision: CodexFileChangeApprovalDecision
}

export interface CodexPermissionsRequestApprovalResponse {
  decision: CodexPermissionsApprovalDecision
}

// =============================================================================
// JSON-RPC method names — kept as a const union so the adapter switch is
// exhaustive and TypeScript catches new methods at compile time.
// =============================================================================

export const CODEX_APPROVAL_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
] as const

export type CodexApprovalMethod = (typeof CODEX_APPROVAL_METHODS)[number]
