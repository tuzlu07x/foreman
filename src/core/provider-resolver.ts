// =============================================================================
// Per-agent provider resolver (#408 / #410 — Phase 2)
// =============================================================================
//
// Converts Foreman's abstract `(agent, foremanProvider, model)` triple into a
// concrete config the agent's native runtime accepts.
//
// Background: each agent has its own provider taxonomy (Hermes uses
// `openrouter`, OpenClaw uses native `openai`, Codex prefers OAuth, …). The
// registry's `provider_mapping` block (Phase 1, #409) declares these per-agent
// variants. This resolver reads that mapping + applies `${model}` /
// `${secret:<name>}` template substitution to produce ready-to-write
// `configWrites`, `envVars`, `authJsonWrites`, `tomlWrites`.
//
// Phase 3 (wizard) and Phase 4 (doctor / CLI) all consume this single
// resolver — Foreman's code only handles the mechanic; the data lives in
// the registry, so adding a new agent is a registry-only operation.

import type { AgentEntry } from "./registry-catalog.js";

export interface SecretAcquisition {
  name: string;
  url?: string;
  note?: string;
}

export interface ResolvedAgentProviderConfig {
  agentId: string;
  foremanProvider: string;
  variantId: string;
  variantLabel: string;
  /** Dot-path → value writes against the agent's main config file. The
   *  destination file path is determined by the agent's existing
   *  registry (`secret_projection.config_overrides.path` or similar);
   *  this resolver doesn't pick the path — only produces the value map. */
  configWrites: Record<string, string>;
  /** Env var name → value pairs. Caller writes to the agent's env
   *  mechanism (dotenv or json_env section). */
  envVars: Record<string, string>;
  /** Codex-style flat JSON auth files. */
  authJsonWrites: { path: string; key: string; value: string }[];
  /** TOML config writes (Codex `preferred_auth_method`, ZeroClaw
   *  `default_provider`/`api_key`). */
  tomlWrites: { path: string; key: string; value: string }[];
  /** Foreman secret-store slot name (e.g. `openrouter-key`). `null`
   *  for OAuth-based variants that don't need a key. */
  requiredSecret: string | null;
  /** How the user gets this credential — used by wizard + `foreman
   *  provider list` to surface URL hints. */
  secretAcquisition: SecretAcquisition | null;
  /** CLI command the user runs to complete an OAuth flow
   *  (`codex login`, `claude auth login`). `null` for non-OAuth variants. */
  interactiveSetup: string | null;
  /** Command Foreman runs to verify OAuth completed (`codex auth status`). */
  postSetupVerify: string | null;
}

export type ResolveError =
  | {
      kind: "no_mapping";
      agentId: string;
    }
  | {
      kind: "unsupported_provider";
      foremanProvider: string;
      availableProviders: string[];
    }
  | {
      kind: "unknown_variant";
      variantId: string;
      available: string[];
    }
  | {
      kind: "missing_secret";
      secretName: string;
      acquisition: SecretAcquisition | null;
    };

export type ResolveResult =
  | { ok: true; config: ResolvedAgentProviderConfig }
  | { ok: false; error: ResolveError };

export interface ResolveOptions {
  agent: AgentEntry;
  /** Foreman-level provider id, e.g. `"openai"`, `"anthropic"`, `"gemini"`. */
  foremanProvider: string;
  /** Bare model id (e.g. `"gpt-4o-mini"`). Substituted for `${model}` in
   *  variant template strings. */
  modelId: string;
  /** Override the preferred variant — e.g. user picked
   *  `via-codex-oauth` over `via-openrouter` for Hermes. */
  variantOverride?: string;
  /** Secret store lookup. When provided:
   *   - The resolver validates the variant's `required_secret` is present
   *     and returns `missing_secret` error if not.
   *   - `${secret:<name>}` tokens in writes/env_vars are substituted with
   *     the actual stored value.
   *  When omitted (e.g. doctor inspecting "what would happen if…"):
   *   - Missing-secret check is skipped.
   *   - `${secret:<name>}` tokens are LEFT in place. */
  secretLookup?: (name: string) => string | null;
}

/**
 * Resolve an agent's provider_mapping for a given Foreman provider choice.
 * Returns concrete writes ready for the projector to apply, or a typed
 * error describing what's missing.
 */
export function resolveAgentProviderConfig(
  opts: ResolveOptions,
): ResolveResult {
  const { agent, foremanProvider, modelId, variantOverride, secretLookup } =
    opts;

  if (!agent.provider_mapping) {
    return { ok: false, error: { kind: "no_mapping", agentId: agent.id } };
  }

  const providerEntry = agent.provider_mapping[foremanProvider];
  if (!providerEntry) {
    return {
      ok: false,
      error: {
        kind: "unsupported_provider",
        foremanProvider,
        availableProviders: Object.keys(agent.provider_mapping),
      },
    };
  }

  const variantId = variantOverride ?? providerEntry.preferred;
  const variant = providerEntry.variants[variantId];
  if (!variant) {
    return {
      ok: false,
      error: {
        kind: "unknown_variant",
        variantId,
        available: Object.keys(providerEntry.variants),
      },
    };
  }

  // Required-secret check (only when secretLookup provided — doctor's
  // "what would happen if" path skips this so it can report status
  // without resolving values).
  if (secretLookup && variant.required_secret) {
    const value = secretLookup(variant.required_secret);
    if (value === null) {
      return {
        ok: false,
        error: {
          kind: "missing_secret",
          secretName: variant.required_secret,
          acquisition: variant.secret_acquisition ?? null,
        },
      };
    }
  }

  // Template substitution. `${model}` → modelId, `${secret:<name>}` →
  // lookup result. When secretLookup absent, `${secret:…}` tokens are
  // preserved verbatim so callers (doctor) can surface the literal
  // template for diagnostics.
  const sub = (s: string): string =>
    substituteTemplate(s, { modelId, secretLookup });

  const configWrites: Record<string, string> = {};
  for (const [k, v] of Object.entries(variant.writes ?? {})) {
    configWrites[k] = sub(v);
  }

  const envVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(variant.env_vars ?? {})) {
    envVars[k] = sub(v);
  }

  const authJsonWrites = variant.auth_json_writes
    ? [
        {
          path: variant.auth_json_writes.path,
          key: variant.auth_json_writes.key,
          value: sub(variant.auth_json_writes.value),
        },
      ]
    : [];

  const tomlWrites = (variant.toml_writes ?? []).map((w) => ({
    path: w.path,
    key: w.key,
    value: sub(w.value),
  }));

  return {
    ok: true,
    config: {
      agentId: agent.id,
      foremanProvider,
      variantId,
      variantLabel: variant.label,
      configWrites,
      envVars,
      authJsonWrites,
      tomlWrites,
      requiredSecret: variant.required_secret ?? null,
      secretAcquisition: variant.secret_acquisition ?? null,
      interactiveSetup: variant.interactive_setup ?? null,
      postSetupVerify: variant.post_setup_verify ?? null,
    },
  };
}

/**
 * Human-readable description of a ResolveError, suitable for surfacing
 * in CLI output or wizard error banners.
 */
export function describeResolveError(err: ResolveError): string {
  switch (err.kind) {
    case "no_mapping":
      return `agent "${err.agentId}" has no provider_mapping in the registry`;
    case "unsupported_provider":
      return `provider "${err.foremanProvider}" not supported — available: ${err.availableProviders.join(", ")}`;
    case "unknown_variant":
      return `variant "${err.variantId}" not found — available: ${err.available.join(", ")}`;
    case "missing_secret":
      return `required secret "${err.secretName}" not in Foreman secret store`;
  }
}

// =============================================================================
// Internals
// =============================================================================

const MODEL_TOKEN_RE = /\$\{model\}/g;
const SECRET_TOKEN_RE = /\$\{secret:([a-z][a-z0-9-]*)\}/gi;

function substituteTemplate(
  template: string,
  ctx: {
    modelId: string;
    secretLookup?: (name: string) => string | null;
  },
): string {
  let result = template.replace(MODEL_TOKEN_RE, ctx.modelId);
  result = result.replace(SECRET_TOKEN_RE, (match, name: string) => {
    if (!ctx.secretLookup) return match;
    const value = ctx.secretLookup(name);
    return value ?? "";
  });
  return result;
}

// =============================================================================
// Default model picks per Foreman provider
// =============================================================================
//
// Used by the projector when the wizard hasn't surfaced a per-agent model
// choice yet (Phase 2 hardcoded fallback). Phase 3 wizard will let the user
// pick, and Phase 5 will hook the live-model-picker (PR #405) into this.
const DEFAULT_MODEL_PER_PROVIDER: Record<string, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
  gemini: "gemini-2.0-flash",
  ollama: "llama3.2",
};

export function deriveDefaultModelId(foremanProvider: string): string {
  return DEFAULT_MODEL_PER_PROVIDER[foremanProvider] ?? "default";
}
