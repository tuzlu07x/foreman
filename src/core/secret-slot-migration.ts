// =============================================================================
// Legacy secret slot migration (#342)
// =============================================================================
//
// #291 unified provider secret naming to `<provider>-key`. Fresh users get
// the clean naming; users who ran setup before #291 still carry the old
// `<provider>-api-key` slots in their vault, and the new wizard writes
// `<provider>-key` on top — leaving both:
//
//   anthropic-key      ← new (#291 wizard)
//   anthropic-api-key  ← old (pre-#291 wizard, dead weight)
//
// Two consumers:
//   - `foreman secrets dedupe-providers` CLI (manual cleanup)
//   - doctor check that surfaces the duplicates as a warn
//
// Pure helper here so both can share the detection + the policy on which
// slot wins.

export interface SecretSlotPair {
  /** Canonical slot — the one we keep. */
  canonical: string;
  /** Legacy slot — the one we drop. */
  legacy: string;
  /** Provider id this pair belongs to (for messaging). */
  provider: string;
}

const KNOWN_PROVIDER_PAIRS: SecretSlotPair[] = [
  { canonical: "anthropic-key", legacy: "anthropic-api-key", provider: "anthropic" },
  { canonical: "openai-key", legacy: "openai-api-key", provider: "openai" },
  { canonical: "gemini-key", legacy: "gemini-api-key", provider: "gemini" },
  {
    canonical: "openai-compatible-key",
    legacy: "openai-compatible-api-key",
    provider: "openai_compatible",
  },
];

/**
 * Find every duplicate slot pair in the user's vault. Returns the pairs
 * where BOTH the canonical and legacy slot exist — the dedupe CLI removes
 * the legacy side; doctor surfaces the count as a warn.
 */
export function findDuplicateSlots(
  storedNames: Iterable<string>,
): SecretSlotPair[] {
  const names = new Set(storedNames);
  return KNOWN_PROVIDER_PAIRS.filter(
    (pair) => names.has(pair.canonical) && names.has(pair.legacy),
  );
}

/**
 * For each duplicate pair, decide which slot is "live" — i.e. which value
 * we want to keep. By default the canonical slot wins; callers can pass a
 * `lastAccessedAt` lookup so the more-recently-used slot wins instead.
 *
 * Returns the names of legacy slots safe to remove.
 */
export function legacySlotsToRemove(
  duplicates: SecretSlotPair[],
  lastAccessedAt?: (name: string) => number | null,
): string[] {
  const out: string[] = [];
  for (const pair of duplicates) {
    if (lastAccessedAt) {
      const c = lastAccessedAt(pair.canonical) ?? 0;
      const l = lastAccessedAt(pair.legacy) ?? 0;
      // Tie / canonical wins by default — only flip when the legacy slot
      // was used strictly more recently (user might still be relying on it).
      if (l > c) {
        // Skip — user clearly uses the legacy slot; surface as a manual
        // decision rather than auto-removing live data.
        continue;
      }
    }
    out.push(pair.legacy);
  }
  return out;
}
