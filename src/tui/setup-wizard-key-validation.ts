import type { ProviderEntry } from "../core/registry-catalog.js";
import {
  detectProviderByPrefix,
  KNOWN_PREFIXES,
} from "../core/key-prefix-detect.js";

// =============================================================================
// Paste-time key prefix validation (#291)
// =============================================================================
//
// QA round 2 found the same user (me) pasted an OpenAI sk-proj-… key into
// the Anthropic key slot during the wizard. The wizard accepted it silently,
// stored it, and downstream `foreman llm test` failed with a confusing
// HTTP 401. A cheap check at paste time — does this look like the right kind
// of key for this provider — catches that error in the right context.
//
// Three rules we deliberately follow:
//
//   1. **Warn, don't reject.** Users may run forks, proxies, or private
//      builds where the prefix doesn't match the public convention. Save
//      anyway; surface a warning the user can dismiss by pressing Enter
//      again.
//   2. **Skip when the catalog says null.** Providers without a stable
//      prefix (Ollama, openai-compatible) opt out by setting
//      `key_prefix: null`.
//   3. **Detect cross-provider pastes.** When the pasted value matches
//      *another* known provider's prefix, the warning calls out which
//      provider it actually looks like — that's the high-value message,
//      not just "wrong format".
//
// The prefix table + most-specific-wins detection live in
// src/core/key-prefix-detect.ts (#307) — also used by `foreman doctor`'s
// llm.credentials check.

export interface ValidateKeyPasteInput {
  provider: ProviderEntry;
  value: string;
}

export interface ValidateKeyPasteResult {
  /** True when the pasted value matches the catalog's expected prefix or
   *  when the provider opted out of validation. */
  ok: boolean;
  /** Set when ok is false — human-readable text to render under the input
   *  before the user accepts the value anyway. */
  warning: string | null;
}

/**
 * Pure check — does this pasted value look like the right kind of key for
 * the configured provider? Returns ok=true for opt-outs (`key_prefix:
 * null`), opt-ins with matching prefix, and pasted values that match no
 * known prefix at all (probably just a typo, not a cross-provider paste).
 *
 * Returns ok=false ONLY when we're confident the user pasted a key
 * belonging to a different provider.
 *
 * Prefix ambiguity note: OpenAI's "sk-" is a sub-prefix of Anthropic's
 * "sk-ant-". A value starting "sk-ant-..." matches BOTH prefixes. We
 * resolve by picking the **longest** matching prefix first (most-specific
 * wins), so "sk-ant-..." correctly resolves to Anthropic.
 */
export function validateKeyPaste(
  input: ValidateKeyPasteInput,
): ValidateKeyPasteResult {
  const expected = input.provider.key_prefix;
  if (!expected) return { ok: true, warning: null };
  if (input.value.length === 0) return { ok: true, warning: null };

  const detected = detectProviderByPrefix(input.value);

  // What's the human-readable provider name our `expected` prefix belongs
  // to? (Used to decide "is the detected provider the same as the
  // configured one".)
  const expectedProviderName =
    KNOWN_PREFIXES.find((p) => p.prefix === expected)?.provider ??
    input.provider.name;

  if (detected && detected.provider === expectedProviderName) {
    return { ok: true, warning: null };
  }

  if (detected) {
    return {
      ok: false,
      warning:
        `this looks like a ${detected.provider} key (starts with "${detected.prefix}"), ` +
        `but you're saving it as ${input.provider.name} (expects "${expected}"). ` +
        `Saved anyway — fix with \`foreman secrets rotate ${input.provider.secret_name ?? input.provider.id + "-key"}\` if it was a paste error.`,
    };
  }

  // Doesn't match any known prefix → could be a typo, could be a private
  // build. Soft warning that just nudges the user to check.
  return {
    ok: false,
    warning:
      `expected ${input.provider.name} key to start with "${expected}". ` +
      `Saved anyway — rotate via secrets page if needed.`,
  };
}
