/**
 * Approval ID format helpers (#552 PR 5).
 *
 * Background — operators have confused Foreman approval ids with agent
 * session ids in the wild. The clearest case from the #552 investigation:
 *
 *     approve_remember 019e5e5e-9ce6-7172-af2f-ff9cca12608a
 *
 * That string is a *codex session id* (UUID-shaped). Foreman approval ids
 * are ULIDs (`01HZX…A2K3`, 26 chars, base32 alphabet, no hyphens). When
 * the operator passed the UUID, `submit_approval` correctly returned
 * "approval not found" — but the error gave no hint about *why* the id
 * was wrong, so the user re-typed the same UUID expecting it to work.
 *
 * This module provides three tiny pure helpers used by:
 *   - `src/core/notification/channels/telegram.ts` (display)
 *   - `src/cli/mcp-stdio.ts` `submit_approval` handler (parse + smart
 *     error)
 *
 * Surgical scope — the underlying stored id in the DB (`pendingApprovals
 * .requestId`) does NOT change. We only prefix in display and strip on
 * submission, keeping every existing audit row + DB row format-stable.
 */

/** Visible prefix on every approval id surfaced to chat. The prefix is
 *  short so it doesn't bloat the slash command + screen-reader-friendly
 *  ("aprv" reads as "approve"). */
export const APPROVAL_ID_DISPLAY_PREFIX = 'aprv_'

/** ULID — 26 chars, Crockford base32 (no I/L/O/U). The mediator generates
 *  these via `ulid()`. Match the canonical shape so we can distinguish a
 *  bare-ULID input (back-compat) from arbitrary junk. */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i

/** Canonical UUID v4-ish shape (8-4-4-4-12 hex with hyphens). Used as a
 *  heuristic to spot agent session ids the user pasted by mistake. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Wrap a raw approval id (ULID) for display in chat. Chat consumers should
 * call this anywhere they previously interpolated the bare id into a
 * slash command or callback label.
 *
 * Idempotent — if `id` is already prefixed it is returned unchanged.
 */
export function formatApprovalIdForDisplay(id: string): string {
  if (id.startsWith(APPROVAL_ID_DISPLAY_PREFIX)) return id
  return `${APPROVAL_ID_DISPLAY_PREFIX}${id}`
}

/**
 * Strip the display prefix off a submitted id, leaving the underlying
 * storage id. Accepts both new (prefixed) and legacy (bare) forms so a
 * user re-typing a notification from before this change still works.
 *
 * Trims whitespace and normalises case before stripping so a copy/paste
 * with stray spaces still resolves.
 */
export function parseSubmittedApprovalId(input: string): string {
  const trimmed = input.trim()
  if (trimmed.toLowerCase().startsWith(APPROVAL_ID_DISPLAY_PREFIX)) {
    return trimmed.slice(APPROVAL_ID_DISPLAY_PREFIX.length)
  }
  return trimmed
}

/**
 * Result of classifying a user-supplied approval id input. The
 * `mcp-stdio` submit_approval handler uses this to decide whether the
 * "not found" path should say "no such approval" (genuinely unknown id
 * shape) or "that looks like an agent session id, not a Foreman approval
 * id" (UUID shape).
 *
 * `stripped` is always the input minus any `aprv_` prefix — callers pass
 * it onward to the approval store regardless of classification, because
 * the store has the final word.
 */
export interface ApprovalIdClassification {
  /**
   *   foreman_approval — string matches Foreman's ULID format (with or
   *                      without the aprv_ prefix). Most calls land
   *                      here; the "not found" error from the store is
   *                      the actionable signal.
   *
   *   looks_like_agent_session — string matches the canonical UUID
   *                              shape. Almost certainly a codex /
   *                              claude-code thread id pasted by
   *                              mistake. Surface a hint pointing the
   *                              user back at the original
   *                              notification.
   *
   *   unknown — input doesn't match either format. Could be a typo, a
   *             prefix-only fragment, or a wholly unrelated string.
   *             Render a generic "id format not recognised" hint.
   */
  kind: 'foreman_approval' | 'looks_like_agent_session' | 'unknown'
  /** The input with any aprv_ prefix removed (and whitespace trimmed).
   *  Callers feed this to the approval store. */
  stripped: string
}

/** Classify a user-submitted approval id so the caller can render an
 *  informative error when the underlying store reports "not found". */
export function classifyApprovalIdInput(input: string): ApprovalIdClassification {
  const stripped = parseSubmittedApprovalId(input)
  if (ULID_PATTERN.test(stripped)) {
    return { kind: 'foreman_approval', stripped }
  }
  if (UUID_PATTERN.test(stripped)) {
    return { kind: 'looks_like_agent_session', stripped }
  }
  return { kind: 'unknown', stripped }
}

/** Human-language hint for the operator when an approval lookup misses.
 *  Caller decides whether to prepend the underlying store's "approval
 *  not found" message; this helper just provides the contextual nudge. */
export function approvalIdMissHint(classification: ApprovalIdClassification): string {
  switch (classification.kind) {
    case 'foreman_approval':
      // Format is right — the id is just unknown / already resolved /
      // from a different Foreman instance. Direct the user back to the
      // chat notification.
      return (
        'Approval id format looks right (ULID) but no pending approval matches. ' +
        'Re-check the latest Foreman approval notification in this chat — ' +
        'the id may already be resolved, or you copied an older one.'
      )
    case 'looks_like_agent_session':
      return (
        'That looks like an agent session/thread id (UUID), not a Foreman ' +
        'approval id. Foreman approval ids are 26-char ULIDs and appear in ' +
        'the Foreman approval notification in your chat, usually prefixed ' +
        `with \`${APPROVAL_ID_DISPLAY_PREFIX}\`.`
      )
    case 'unknown':
      return (
        'That id does not match the Foreman approval format. Approval ids ' +
        `look like \`${APPROVAL_ID_DISPLAY_PREFIX}01HZX...A2K3\` — 26-char ` +
        'ULIDs from the most recent Foreman approval notification in this chat.'
      )
  }
}
