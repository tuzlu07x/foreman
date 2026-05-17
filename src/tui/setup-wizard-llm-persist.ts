import type { LlmConfig, ProviderId } from "../core/llm/config.js";
import type { ProviderEntry } from "../core/registry-catalog.js";

// =============================================================================
// Wizard → llm.yaml persistence (#289)
// =============================================================================
//
// Pure logic for taking the list of provider storage names the wizard stored
// in the secret vault during step "providers" and translating them into a
// usable llm.yaml. Before this, the wizard collected keys + summary said
// "2 LLM providers configured" but llm.yaml never landed on disk, so every
// downstream feature (verification, smart_report, llm test) silently broke.
//
// We do this as a pure function over `existing` (the prior llm.yaml content)
// so we don't clobber user overrides to non-credential fields and so the
// tests can pin behaviour without a tmp dir.

export interface BuildLlmConfigInput {
  /** Storage names the wizard saved into the secret store (providersSaved). */
  savedStorageNames: string[];
  /** Provider catalog rows used to resolve storage names back to providers. */
  providerCatalog: ProviderEntry[];
  /** Existing llm.yaml content (loaded by caller). We merge into this so a
   *  user's manual override of `model` / `budget` / `features` survives a
   *  wizard re-run. */
  existing: LlmConfig;
}

export interface BuildLlmConfigResult {
  /** The config to write back; identical to `existing` when nothing was
   *  saved (caller can short-circuit the write). */
  next: LlmConfig;
  /** Which providers got wired up (canonical ProviderId, dedup'd). Empty when
   *  the wizard saved nothing. */
  wiredProviders: ProviderId[];
}

// Catalog ids → ProviderId enum. The catalog calls openai_compatible "custom"
// for UX reasons; the enum keeps the schema-level name.
const CATALOG_ID_TO_PROVIDER: Record<string, ProviderId> = {
  anthropic: "anthropic",
  openai: "openai",
  gemini: "gemini",
  ollama: "ollama",
  custom: "openai_compatible",
};

/**
 * Walk the saved-names list, map each back to a catalog entry, and produce a
 * fresh llm.yaml content that:
 *   - turns the global switch on,
 *   - picks the first saved provider as the default (#297 will refine to a
 *     per-agent + per-Foreman picker),
 *   - turns verification + smart_report on so the LLM features actually fire,
 *   - merges credentials.<provider>.secret_name (and endpoint_secret for the
 *     endpoint-driven providers — ollama, openai_compatible).
 *
 * Returns wiredProviders so the caller can render "✓ Wrote llm.yaml — primary
 * provider: openai" in the wizard summary.
 */
export function buildLlmConfigFromWizard(
  input: BuildLlmConfigInput,
): BuildLlmConfigResult {
  const wired: ProviderId[] = [];
  const credentialsUpdate: Record<
    string,
    { secret_name?: string | null; endpoint_secret?: string }
  > = {};

  for (const storageName of input.savedStorageNames) {
    const catalogEntry = resolveCatalogEntry(
      storageName,
      input.providerCatalog,
    );
    if (!catalogEntry) continue;
    const providerId = CATALOG_ID_TO_PROVIDER[catalogEntry.entry.id];
    if (!providerId) continue;
    if (!wired.includes(providerId)) wired.push(providerId);

    const slot = credentialsUpdate[providerId] ?? {};
    if (catalogEntry.kind === "secret") {
      slot.secret_name = storageName;
    } else {
      // Endpoint prompt — wizard stored it as a "secret" in the vault since
      // values are opaque there. The runtime reads it back via endpoint_secret.
      slot.endpoint_secret = storageName;
    }
    credentialsUpdate[providerId] = slot;
  }

  if (wired.length === 0) {
    return { next: input.existing, wiredProviders: [] };
  }

  return {
    next: {
      ...input.existing,
      enabled: true,
      provider: wired[0]!,
      features: {
        ...input.existing.features,
        verification: true,
        smart_report: true,
      },
      credentials: mergeCredentials(
        input.existing.credentials,
        credentialsUpdate,
      ),
    },
    wiredProviders: wired,
  };
}

interface ResolvedCatalogEntry {
  entry: ProviderEntry;
  kind: "secret" | "endpoint";
}

function resolveCatalogEntry(
  storageName: string,
  catalog: ProviderEntry[],
): ResolvedCatalogEntry | null {
  // Secret-named providers: storageName === entry.secret_name
  const bySecret = catalog.find((p) => p.secret_name === storageName);
  if (bySecret) return { entry: bySecret, kind: "secret" };
  // Endpoint-only providers: wizard stored as `${entry.id}-endpoint`
  const byEndpoint = catalog.find(
    (p) => `${p.id}-endpoint` === storageName,
  );
  if (byEndpoint) return { entry: byEndpoint, kind: "endpoint" };
  return null;
}

function mergeCredentials(
  existing: LlmConfig["credentials"],
  updates: Record<
    string,
    { secret_name?: string | null; endpoint_secret?: string }
  >,
): LlmConfig["credentials"] {
  const next: LlmConfig["credentials"] = { ...existing };
  for (const [provider, fields] of Object.entries(updates)) {
    const prior = (next as Record<string, unknown>)[provider] as
      | Record<string, unknown>
      | undefined;
    (next as Record<string, unknown>)[provider] = {
      ...(prior ?? {}),
      ...fields,
    };
  }
  return next;
}
