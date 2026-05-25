/**
 * Synthetic update template renderer (#445 PR 3).
 *
 * Walks the `synthetic_update_template` JSON declared in an agent's
 * registry entry and substitutes the three reserved tokens:
 *
 *   `{auto}`         — wrap allocates a monotonic update_id per session.
 *                       Rendered as a NUMBER so Telegram-shaped consumers
 *                       (which expect `update_id` as int) parse cleanly.
 *   `{ownerChatId}`  — primary chat user id from #426. Rendered as a
 *                       NUMBER for the same reason — Telegram from.id /
 *                       chat.id fields are numeric.
 *   `{directive}`    — the user-supplied directive body. Rendered as a
 *                       STRING.
 *
 * Substitution policy:
 *   - Only WHOLE-STRING values are token replacement targets. A field
 *     like `"text": "{directive}"` gets the directive as the new value;
 *     a field like `"text": "directive: {directive}"` is left
 *     untouched (no partial interpolation in this PR). Partial-string
 *     interpolation can land as a follow-up if a real agent's protocol
 *     needs it.
 *   - Tokens nested in objects / arrays are walked recursively.
 *   - Unknown tokens (anything in `{...}` that isn't one of the three
 *     reserved) are left as-is so a future template can add new
 *     placeholders without a parser update.
 *
 * Pure function — no IO, no clock, no randomness (the {auto} value is
 * supplied by the caller's session counter). Trivially unit-testable.
 */

export interface SyntheticUpdateContext {
  /** Monotonic update_id the wrap allocates per directive. Caller
   *  owns the counter so a wrap can renumber across reconnects. */
  autoUpdateId: number
  /** Primary chat owner id from #426. */
  ownerChatId: number
  /** The user-supplied directive body. */
  directive: string
}

/** Reserved token strings. Kept as constants so the renderer + tests
 *  share one source of truth. */
const TOKEN_AUTO = '{auto}'
const TOKEN_OWNER_CHAT_ID = '{ownerChatId}'
const TOKEN_DIRECTIVE = '{directive}'

/** Result type the renderer produces — same JSON shape as the input
 *  template with tokens substituted. */
export type RenderedUpdate = unknown

/**
 * Render the template against the supplied context. Returns a fresh
 * object — input template is never mutated, so callers can keep a
 * single template instance and render it many times safely.
 */
export function renderSyntheticUpdate(
  template: unknown,
  ctx: SyntheticUpdateContext,
): RenderedUpdate {
  return renderNode(template, ctx)
}

function renderNode(node: unknown, ctx: SyntheticUpdateContext): unknown {
  if (typeof node === 'string') {
    return substituteToken(node, ctx)
  }
  if (Array.isArray(node)) {
    return node.map((item) => renderNode(item, ctx))
  }
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = renderNode(value, ctx)
    }
    return out
  }
  return node
}

/**
 * Whole-string match → substitute. Anything else passes through.
 * Numbers / booleans / null in the template are returned unchanged.
 */
function substituteToken(s: string, ctx: SyntheticUpdateContext): unknown {
  switch (s) {
    case TOKEN_AUTO:
      return ctx.autoUpdateId
    case TOKEN_OWNER_CHAT_ID:
      return ctx.ownerChatId
    case TOKEN_DIRECTIVE:
      return ctx.directive
    default:
      return s
  }
}
