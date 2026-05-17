// =============================================================================
// Provider key prefix detection — shared by wizard paste validation (#291)
// and doctor llm.credentials check (#307).
// =============================================================================
//
// Most-specific-prefix-wins. "sk-ant-..." matches both Anthropic's "sk-ant-"
// and OpenAI's "sk-" prefixes; we sort by length descending so the longer
// (more specific) prefix wins.
//
// Lives in core/ — both src/tui/setup-wizard-key-validation.ts and
// src/core/doctor.ts pull from here, no duplication.

export interface KnownPrefix {
  prefix: string;
  /** Human-readable provider name (rendered in messages). */
  provider: string;
  /** Canonical provider id from the catalog (anthropic / openai / gemini). */
  providerId: string;
}

export const KNOWN_PREFIXES: KnownPrefix[] = [
  { prefix: "sk-ant-", provider: "Anthropic", providerId: "anthropic" },
  { prefix: "sk-proj-", provider: "OpenAI", providerId: "openai" },
  { prefix: "sk-", provider: "OpenAI", providerId: "openai" },
  { prefix: "AIza", provider: "Google Gemini", providerId: "gemini" },
];

/**
 * Detect which provider a value's prefix belongs to, picking the longest
 * matching prefix (most specific). Returns null when no known prefix
 * matches (private fork, custom proxy, or just garbage).
 */
export function detectProviderByPrefix(value: string): KnownPrefix | null {
  const sorted = [...KNOWN_PREFIXES].sort(
    (a, b) => b.prefix.length - a.prefix.length,
  );
  return sorted.find((p) => value.startsWith(p.prefix)) ?? null;
}
