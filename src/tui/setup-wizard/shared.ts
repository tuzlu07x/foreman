import { oauthSecretName } from "../../core/llm/oauth/token-store.js";
import {
  findAgent,
  loadActiveRegistry,
  type AgentEntry,
  type ProviderEntry,
} from "../../core/registry-catalog.js";

export const DEFAULT_AGENTS = ["hermes", "claude-code"];

// Faz 4b-3 / #512 — providers that support subscription OAuth as an
// alternative to an API key. Used by the values phase to ask "key or sign
// in?" before the password prompt for these providers. Mirrors the catalog
// in src/core/llm/oauth/oauth-providers.ts.
export const OAUTH_CAPABLE_WIZARD_PROVIDERS = new Set<"anthropic" | "openai">([
  "anthropic",
  "openai",
]);
export function isOAuthCapableProvider(
  id: string,
): id is "anthropic" | "openai" {
  return (OAUTH_CAPABLE_WIZARD_PROVIDERS as Set<string>).has(id);
}

// #448 — Compute a sliding window around the cursor for picker
// render blocks where the list can be longer than the visible
// region. Keeps the cursor inside [start, start+size-1] so down-
// arrow past the bottom slides the window down, not off-screen.
// Returns hidden counts so the render can show "N more above /
// below" hints. Window size kept at 12 to match the existing
// density of the model-pick picker.
export interface PickerViewport<T> {
  visible: T[];
  start: number;
  topHidden: number;
  bottomHidden: number;
}

export function computePickerViewport<T>(
  items: T[],
  cursorIdx: number,
  size: number,
): PickerViewport<T> {
  const total = items.length;
  if (total <= size) {
    return { visible: items, start: 0, topHidden: 0, bottomHidden: 0 };
  }
  const half = Math.floor(size / 2);
  let start = Math.max(0, cursorIdx - half);
  if (start + size > total) start = total - size;
  if (start < 0) start = 0;
  return {
    visible: items.slice(start, start + size),
    start,
    topHidden: start,
    bottomHidden: total - (start + size),
  };
}

// Returns the ids of catalog entries whose required secrets/endpoints are
// present in the store. Used by the Done screen to render real counts for
// providers and services rather than a fragile string parse of install log.
export function configuredProviderIds(
  providers: ProviderEntry[],
  storedNames: Set<string>,
): string[] {
  return providers
    .filter((p) => {
      if (p.secret_name && storedNames.has(p.secret_name)) return true;
      if (p.endpoint_required && storedNames.has(`${p.id}-endpoint`))
        return true;
      return false;
    })
    .map((p) => p.id);
}

/**
 * #575 — Provider ids usable as **Foreman's brain**, counting BOTH API keys
 * and OAuth subscriptions.
 *
 * A user with a ChatGPT or Claude subscription can run Foreman's brain with
 * no API key at all: `openai` + `auth_mode: oauth` routes to the Codex client
 * (chatgpt.com/backend-api), `anthropic` + `auth_mode: oauth` to the Claude
 * subscription client — see `src/core/llm/factory.ts`. The brain picker used
 * to gate on API-key secret slots only (`configuredProviderIds`), so a
 * subscription-only user saw OpenAI/Anthropic greyed out even though those
 * are exactly the paths they can use.
 *
 * A provider counts as configured when ANY of these hold:
 *   - an API key (or required endpoint) is stored → `configuredProviderIds`
 *   - the user chose "sign in with subscription" earlier this wizard run
 *     (`signedInThisSession`, before the queued `foreman llm login` runs)
 *   - OAuth tokens are already on disk from a previous `foreman llm login`
 *     (`llm-oauth-<provider>` secret slot)
 */
export function configuredBrainProviderIds(
  providers: ProviderEntry[],
  storedNames: Set<string>,
  signedInThisSession: readonly ("anthropic" | "openai")[] = [],
): Set<string> {
  const ids = new Set(configuredProviderIds(providers, storedNames));
  for (const pid of signedInThisSession) ids.add(pid);
  for (const pid of OAUTH_CAPABLE_WIZARD_PROVIDERS) {
    if (storedNames.has(oauthSecretName(pid))) ids.add(pid);
  }
  return ids;
}

/** Providers still to sign in to after the wizard: a subscription was
 *  chosen, and no API key for the provider was saved in this run (a key
 *  saved now wins, as in llm.yaml; a key from an earlier run doesn't cancel
 *  a sign-in chosen now). */
export function foremanLlmLoginsNeeded(
  signedIn: readonly string[],
  providers: ProviderEntry[],
  savedThisRun: ReadonlySet<string>,
): string[] {
  return signedIn.filter((pid) => {
    const secret = providers.find((p) => p.id === pid)?.secret_name;
    return !(secret && savedThisRun.has(secret));
  });
}

export function configuredServiceIds(
  services: { id: string; secret_name: string }[],
  storedNames: Set<string>,
): string[] {
  return services
    .filter((s) => storedNames.has(s.secret_name))
    .map((s) => s.id);
}

export function safeFind(
  doc: ReturnType<typeof loadActiveRegistry>["doc"],
  id: string,
): AgentEntry | null {
  try {
    return findAgent(doc, id);
  } catch {
    return null;
  }
}
