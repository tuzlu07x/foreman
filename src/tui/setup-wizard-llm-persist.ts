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

// Per-provider default model — used when the wizard flips `provider` and the
// existing `model` belongs to a different provider (#340). Picked to be cheap
// + production-suitable; user can override in llm.yaml afterwards.
const PROVIDER_DEFAULT_MODEL: Record<ProviderId, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
  ollama: "llama3",
  openai_compatible: "gpt-4o-mini",
};

// Catalog of every model name we recognise as a default for SOME provider.
// `belongsToProvider(model)` returns which provider that model is native to,
// so the wizard can detect "Anthropic default sitting in openai's slot".
const KNOWN_MODEL_PREFIXES: { prefix: string; provider: ProviderId }[] = [
  { prefix: "claude", provider: "anthropic" },
  { prefix: "gpt", provider: "openai" },
  { prefix: "o1", provider: "openai" },
  { prefix: "o3", provider: "openai" },
  { prefix: "gemini", provider: "gemini" },
  { prefix: "llama", provider: "ollama" },
  { prefix: "mistral", provider: "ollama" },
  { prefix: "qwen", provider: "ollama" },
];

function belongsToProvider(model: string): ProviderId | null {
  const lower = model.toLowerCase();
  for (const { prefix, provider } of KNOWN_MODEL_PREFIXES) {
    if (lower.startsWith(prefix)) return provider;
  }
  return null;
}

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

  const nextProvider = wired[0]!;
  // #340 — when the wizard flips `provider`, also update `model` if the
  // existing model belongs to a different provider. Preserves user
  // overrides (a model native to the new provider is kept as-is).
  const existingModelOwner = belongsToProvider(input.existing.model);
  const nextModel =
    existingModelOwner !== null && existingModelOwner !== nextProvider
      ? PROVIDER_DEFAULT_MODEL[nextProvider]
      : input.existing.model;

  return {
    next: {
      ...input.existing,
      enabled: true,
      provider: nextProvider,
      model: nextModel,
      features: {
        ...input.existing.features,
        verification: true,
        smart_report: true,
        // #498 — Default ON so free-form "foreman are you there?" hits
        // the LLM instead of bouncing off "Unknown command". Budget
        // guardrails (monthly_cap_usd) still apply, so the opt-in cost
        // concern doesn't disappear — users just no longer have to
        // hand-edit YAML to talk to Foreman.
        orchestrator_chat: true,
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
  const byEndpoint = catalog.find((p) => `${p.id}-endpoint` === storageName);
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
