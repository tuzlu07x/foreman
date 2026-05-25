/**
 * Adapter registry (#552).
 *
 * Lookup point for "give me the adapter named X" — used by the mediator and
 * the spawn engine to resolve `registry/agents.json`'s `approval_adapter`
 * field into a concrete `AgentAdapter` implementation at runtime.
 *
 * Adapter ids follow `<agent>-<surface>-<version>` so multiple versions can
 * coexist during a migration (e.g. ship `codex-exec-server-v2` alongside
 * `v1`, flip the registry entry, retire v1 when no agent points at it).
 *
 * Adding a new adapter:
 *
 *   1. Create `<surface>-v<n>.ts` next to this file implementing
 *      `AgentAdapter` from `./types.js`.
 *   2. Add it to `ADAPTER_REGISTRY` below.
 *   3. Reference its id from the registry entry in `registry/agents.json`.
 *
 * Unit tests under `tests/core/adapters/` exercise both individual adapters
 * and the registry lookup so a wrongly-typed import gets caught at CI time.
 */

import type { AgentAdapter } from './types.js'
import { codexExecServerV1Adapter } from './codex-exec-server-v1.js'
import { claudeCodePreToolUseV1Adapter } from './claude-code-pretooluse-v1.js'

// Re-export the shared interface bits so consumers can import everything
// from one path (`./adapters/index.js`) without reaching into individual
// adapter files.
export type {
  AgentAdapter,
  NormalisedActionRequest,
  NormalisedDecision,
} from './types.js'
export { AdapterDecodeError, defaultRiskRequest } from './types.js'

// Re-export the wire types alongside the adapters so call sites do not
// have to know the internal layout of `src/core/adapters/`.
export type {
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
export { CODEX_APPROVAL_METHODS } from './codex-approval-types.js'
export type { CodexWireRequest, CodexWireResponse } from './codex-exec-server-v1.js'
export { codexExecServerV1Adapter } from './codex-exec-server-v1.js'

export type {
  ClaudeCodePreToolUsePayload,
  ClaudeCodePreToolUseResponse,
} from './claude-code-pretooluse-v1.js'
export { claudeCodePreToolUseV1Adapter } from './claude-code-pretooluse-v1.js'

/**
 * Registered adapters keyed by stable id. Keep entries alphabetical for
 * easier review and to make conflict-on-add obvious.
 */
const ADAPTER_REGISTRY: Record<string, AgentAdapter> = {
  [claudeCodePreToolUseV1Adapter.id]: claudeCodePreToolUseV1Adapter,
  [codexExecServerV1Adapter.id]: codexExecServerV1Adapter,
}

/** Resolve an adapter id to its implementation. Returns `null` when the id
 *  is unknown so callers can decide between "fail-closed deny" and
 *  "fallback to the implicit default" without a try/catch dance. */
export function getAdapter(id: string): AgentAdapter | null {
  return ADAPTER_REGISTRY[id] ?? null
}

/** Snapshot of every registered adapter id — useful for the registry-
 *  catalog validator (so a `registry/agents.json` entry referencing an
 *  unknown adapter is rejected before runtime) and for the TUI's
 *  `foreman agent show` listing. */
export function listAdapterIds(): string[] {
  return Object.keys(ADAPTER_REGISTRY).sort()
}
