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

import { execFileSync } from "node:child_process";
import { loadActiveProviders, type AgentEntry } from "./registry-catalog.js";

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
  /** #461 — Mandatory OAuth dependency on ANOTHER agent (e.g. Hermes
   *  via-codex-oauth piggybacks on Codex's ChatGPT session). The wizard
   *  shows a label hint at variant-pick time and a mandatory step on
   *  the Done screen so the user doesn't hit a silent provider-auth
   *  failure at runtime. `null` when this variant carries its own auth. */
  dependsOnOauth: ResolvedDependsOnOauth | null;
}

export interface ResolvedDependsOnOauth {
  agent: string;
  setupCommand: string;
  verifyCommand: string | null;
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
   *  `via-codex-oauth` over `via-openrouter` for Hermes. When provided,
   *  skips the version-range filter (the user knows what they want). */
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
  /** #420 — Installed agent version (e.g. "2.1.0"). Used to filter
   *  variants by their `min_agent_version` / `max_agent_version`
   *  range. When omitted, the resolver attempts auto-detect via the
   *  agent's `install.binary --version` command. Pass `null`
   *  explicitly to disable detection (variant ranges become no-ops). */
  agentVersion?: string | null;
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

  // #420 — Variant resolution: explicit override wins (user knows their
  // intent), otherwise filter by agent version range, otherwise fall back
  // to `preferred`.
  const variantId = variantOverride ?? selectVariantByVersion(
    providerEntry.variants,
    providerEntry.preferred,
    resolveAgentVersion(opts),
  );
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
      dependsOnOauth: variant.depends_on_oauth
        ? {
            agent: variant.depends_on_oauth.agent,
            setupCommand: variant.depends_on_oauth.setup_command,
            verifyCommand: variant.depends_on_oauth.verify_command ?? null,
          }
        : null,
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
// #419 — Reads from `registry/providers.json` so new flagship model versions
// (gpt-5, claude-opus-5, gemini-3) can ship as a registry-only edit. No
// TypeScript release required to update defaults.
//
// Falls back to "default" string only when the provider doesn't declare
// `default_model` (e.g. custom OpenAI-compatible endpoints). Caller path
// must still handle this — the projector / live model picker (PR #405)
// override with the user's actual pick at runtime.

export function deriveDefaultModelId(foremanProvider: string): string {
  try {
    const { doc } = loadActiveProviders();
    const entry = doc.providers.find((p) => p.id === foremanProvider);
    if (entry?.default_model) return entry.default_model;
  } catch {
    /* registry load errors fall through to the safe sentinel */
  }
  return "default";
}

// =============================================================================
// #420 — Version-aware variant selection
// =============================================================================
//
// Agents change their config schema between major versions. Without
// version-aware mapping the registry can only ship one shape and break
// users on the other side of an upgrade boundary. This module lets a
// variant declare `min_agent_version` + `max_agent_version` so the
// resolver picks the right one for the user's installed binary.
//
// When the agent's version can't be detected (binary missing, --version
// not supported, parse fails), the resolver falls back to `preferred`.

interface VariantWithRange {
  min_agent_version?: string;
  max_agent_version?: string;
}

/**
 * Pick a variant id based on the agent's installed version. Selection
 * rules (in order):
 *   1. If `preferred` matches the version range, return it.
 *   2. Else scan remaining variants alphabetically; first match wins.
 *   3. Else fall back to `preferred` (best-effort; resolver will error
 *      downstream if the variant doesn't match the agent's config schema).
 */
export function selectVariantByVersion(
  variants: Record<string, VariantWithRange>,
  preferred: string,
  agentVersion: string | null,
): string {
  if (!agentVersion) return preferred;
  const preferredVariant = variants[preferred];
  if (
    preferredVariant &&
    matchesAgentVersion(agentVersion, preferredVariant)
  ) {
    return preferred;
  }
  const sortedIds = Object.keys(variants).sort();
  for (const id of sortedIds) {
    if (id === preferred) continue;
    const v = variants[id];
    if (v && matchesAgentVersion(agentVersion, v)) {
      return id;
    }
  }
  return preferred;
}

/**
 * True when `version` falls within `[min_agent_version, max_agent_version)`.
 * Either bound is optional; missing bounds are treated as "no constraint
 * on that side". Malformed semver strings fail closed (return false).
 */
export function matchesAgentVersion(
  version: string,
  range: VariantWithRange,
): boolean {
  const v = parseSemver(version);
  if (!v) return false;
  if (range.min_agent_version) {
    const min = parseSemver(range.min_agent_version);
    if (!min) return false;
    if (compareSemver(v, min) < 0) return false;
  }
  if (range.max_agent_version) {
    const max = parseSemver(range.max_agent_version);
    if (!max) return false;
    // max is EXCLUSIVE — `1.2.3` is in range `<1.2.3`? No.
    if (compareSemver(v, max) >= 0) return false;
  }
  return true;
}

/**
 * Try to detect the installed agent version by running `<binary> --version`.
 * Returns null when the binary is missing, the command times out, or the
 * output can't be parsed. Detection is best-effort — failures fall back
 * to `preferred` variant. Called by resolveAgentProviderConfig when
 * `opts.agentVersion` is undefined.
 */
export function detectAgentVersion(agent: AgentEntry): string | null {
  const binary = agent.install.binary ?? agent.install.npm ?? null;
  if (!binary) return null;
  try {
    const out = execFileSync(binary, ["--version"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // Extract first `MAJOR.MINOR.PATCH` (+ optional pre-release) from the
    // output. Agents print version in different formats — `1.2.3`,
    // `hermes v1.2.3`, `1.2.3-pre+build`. We just pick the first match.
    const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(out);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

function resolveAgentVersion(opts: ResolveOptions): string | null {
  if (opts.agentVersion !== undefined) return opts.agentVersion;
  return detectAgentVersion(opts.agent);
}

// -----------------------------------------------------------------------------
// Local semver — light parser + compare. Mirrors the shape used in
// `update-check.ts` but lives here to avoid a cyclic import (update-check
// pulls in HTTP fetch + registry + etc).
// -----------------------------------------------------------------------------

interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

function parseSemver(s: string): SemverParts | null {
  const m =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      s.trim(),
    );
  if (!m) return null;
  return {
    major: Number.parseInt(m[1] ?? "0", 10),
    minor: Number.parseInt(m[2] ?? "0", 10),
    patch: Number.parseInt(m[3] ?? "0", 10),
    pre: m[4] ?? null,
  };
}

function compareSemver(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === b.pre) return 0;
  if (!a.pre && b.pre) return 1; // stable > pre-release
  if (a.pre && !b.pre) return -1;
  return (a.pre ?? "") > (b.pre ?? "") ? 1 : -1;
}
