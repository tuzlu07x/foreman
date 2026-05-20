// =============================================================================
// Required-setup resolver (#408 / #411 — Phase 3)
// =============================================================================
//
// Aggregates the per-agent provider_resolver output into a single
// pre-install summary the wizard's "Required setup" step renders. For
// each (selected agent × user-picked provider), this module:
//   - Calls resolveAgentProviderConfig
//   - Buckets the required_secret across agents that share it (one
//     paste prompt covers multiple agents that use the same key)
//   - Collects interactive_setup commands into a post-install OAuth
//     queue (shown on the Done screen)
//   - Records resolver errors with human-readable descriptions

import {
  deriveDefaultModelId,
  describeResolveError,
  resolveAgentProviderConfig,
  type SecretAcquisition,
} from "./provider-resolver.js";
import type { AgentEntry } from "./registry-catalog.js";
import type { SecretStore } from "./secret-store.js";

/** Status of a secret slot:
 *  - `present`: already in Foreman's secret store before this wizard run
 *  - `missing`: required by at least one agent, not in store, no draft yet
 *  - `saved-in-session`: user pasted a value during this wizard run
 *  - `skipped`: user explicitly skipped — install will warn but proceed */
export type SecretStatus =
  | "present"
  | "missing"
  | "saved-in-session"
  | "skipped";

export interface SecretResolution {
  slotName: string;
  /** Which agents need this secret. Multi-agent dedupe — a single
   *  `openai-key` covers OpenClaw + Codex/api-key + ZeroClaw. */
  agents: string[];
  acquisition: SecretAcquisition | null;
  status: SecretStatus;
}

export interface OAuthStep {
  agentId: string;
  variantId: string;
  /** CLI command the user runs to complete the OAuth flow (e.g. `codex
   *  login`, `claude auth login`). */
  command: string;
  /** Optional verify command (`codex auth status`). */
  verify: string | null;
  acquisition: SecretAcquisition | null;
  /** #461 — `true` when this step is a hard prerequisite for the agent
   *  to function (e.g. Hermes via-codex-oauth cannot route ANY request
   *  to OpenAI until `codex login` is done). Wizard renders these in a
   *  separate "must do" block on the Done screen, distinct from the
   *  agent's own optional interactive_setup queue. */
  mandatory: boolean;
  /** Short human reason — explains *why* this step matters when the
   *  link isn't obvious (e.g. the depends_on_oauth case where Hermes'
   *  OAuth lives on the Codex agent). `null` for the legacy
   *  interactive_setup queue where the agent is self-explanatory. */
  reason: string | null;
}

export interface ResolverErrorRecord {
  agentId: string;
  foremanProvider: string;
  error: string;
}

export interface RequiredSetupResolution {
  secrets: SecretResolution[];
  oauthSteps: OAuthStep[];
  errors: ResolverErrorRecord[];
}

export interface ResolveRequiredSetupOptions {
  /** Selected agent entries (already filtered to those the user picked). */
  agents: AgentEntry[];
  /** Map of agentId → Foreman-level provider id the user picked for
   *  that agent. Agents not in this map are skipped (no provider chosen). */
  agentProviders: Record<string, string>;
  /** #450 — Map of agentId → variant id the user picked. When unset
   *  for an agent, resolver uses the registry's `preferred` variant
   *  for that provider. */
  agentVariants?: Record<string, string>;
  /** Used to check which secret slots are already populated. */
  secretStore: SecretStore;
  /** Optional model-id override per Foreman provider. Used by the live
   *  model picker (#399 / PR #405) to feed picked model into resolver
   *  templates. Falls back to `deriveDefaultModelId` per provider. */
  modelOverrides?: Record<string, string>;
  /** Local in-session overrides — secrets the user has already pasted
   *  in this wizard run OR explicitly skipped. Maps slot name → status.
   *  Used so the picker doesn't re-prompt for secrets already handled. */
  sessionOverrides?: Record<string, "saved-in-session" | "skipped">;
}

/**
 * Build the required-setup resolution for the wizard. Idempotent — calling
 * with the same arguments produces identical output, so the wizard can
 * re-render on every keystroke without surprises.
 */
export function resolveRequiredSetup(
  opts: ResolveRequiredSetupOptions,
): RequiredSetupResolution {
  const { agents, agentProviders, secretStore } = opts;
  const sessionOverrides = opts.sessionOverrides ?? {};

  const secretBuckets = new Map<string, SecretResolution>();
  const oauthSteps: OAuthStep[] = [];
  const errors: ResolverErrorRecord[] = [];

  for (const agent of agents) {
    const foremanProvider = agentProviders[agent.id];
    if (!foremanProvider) continue;
    const modelId =
      opts.modelOverrides?.[foremanProvider] ?? defaultModel(foremanProvider);

    const resolved = resolveAgentProviderConfig({
      agent,
      foremanProvider,
      modelId,
      variantOverride: opts.agentVariants?.[agent.id],
    });
    if (!resolved.ok) {
      // Resolver-level errors (no_mapping, unsupported_provider, etc.).
      // These surface on the wizard as red banners — user must change
      // their agent / provider pick before continuing.
      errors.push({
        agentId: agent.id,
        foremanProvider,
        error: describeResolveError(resolved.error),
      });
      continue;
    }

    const cfg = resolved.config;

    // Bucket the required secret across agents that share it.
    if (cfg.requiredSecret) {
      const bucket = secretBuckets.get(cfg.requiredSecret);
      const status = computeSecretStatus(
        cfg.requiredSecret,
        secretStore,
        sessionOverrides,
      );
      if (bucket) {
        if (!bucket.agents.includes(agent.id)) bucket.agents.push(agent.id);
        // Status: take the "most demanding" one. If any agent needs it
        // missing, the bucket is missing. Saved-in-session beats missing,
        // present beats missing, skipped is recorded as-is.
        bucket.status = mergeStatus(bucket.status, status);
      } else {
        secretBuckets.set(cfg.requiredSecret, {
          slotName: cfg.requiredSecret,
          agents: [agent.id],
          acquisition: cfg.secretAcquisition,
          status,
        });
      }
    }

    // Queue OAuth flows (interactive setups). Each is per-agent unique;
    // we don't dedupe `codex login` if multiple agents asked for it
    // because each agent's variant + verify command may differ.
    //
    // QA round 4 discovered: when a variant has `required_secret: null`
    // AND `interactive_setup` AND NO `depends_on_oauth`, that command
    // IS the sole auth path — skipping it leaves the agent unable to
    // reach its provider. Promote to mandatory. Counter-example we must
    // NOT promote: Hermes via-codex-oauth declares `interactive_setup:
    // "hermes model"` (a Hermes-internal config refresh) but its real
    // auth lives in `depends_on_oauth` (codex login). The depends_on_oauth
    // block below already handles that case as mandatory; the
    // interactive_setup stays optional so we don't double-block.
    if (cfg.interactiveSetup) {
      const isSoleAuthPath = !cfg.requiredSecret && !cfg.dependsOnOauth;
      oauthSteps.push({
        agentId: agent.id,
        variantId: cfg.variantId,
        command: cfg.interactiveSetup,
        verify: cfg.postSetupVerify,
        acquisition: cfg.secretAcquisition,
        mandatory: isSoleAuthPath,
        reason: isSoleAuthPath
          ? `${agent.id} authenticates via ${cfg.interactiveSetup} — without it the agent can't reach ${foremanProvider}.`
          : null,
      });
    }

    // #461 — Mandatory cross-agent OAuth dependency. Hermes' via-codex-oauth
    // can't function until Codex is logged in — the user otherwise hits a
    // silent "Provider authentication failed" on the first Telegram message.
    if (cfg.dependsOnOauth) {
      oauthSteps.push({
        agentId: agent.id,
        variantId: cfg.variantId,
        command: cfg.dependsOnOauth.setupCommand,
        verify: cfg.dependsOnOauth.verifyCommand,
        acquisition: null,
        mandatory: true,
        reason: `${agent.id} routes ${foremanProvider} through ${cfg.dependsOnOauth.agent}'s OAuth — finish ${cfg.dependsOnOauth.agent} login or the agent can't reach ${foremanProvider}.`,
      });
    }
  }

  return {
    secrets: Array.from(secretBuckets.values()).sort((a, b) =>
      a.slotName.localeCompare(b.slotName),
    ),
    oauthSteps,
    errors,
  };
}

/** True when the resolution has no outstanding blockers (missing
 *  secrets, resolver errors). OAuth queue does NOT block — those are
 *  post-install steps the user accepts to run manually. */
export function isRequiredSetupComplete(
  resolution: RequiredSetupResolution,
): boolean {
  if (resolution.errors.length > 0) return false;
  for (const s of resolution.secrets) {
    if (s.status === "missing") return false;
  }
  return true;
}

// =============================================================================
// Helpers
// =============================================================================

function computeSecretStatus(
  slotName: string,
  store: SecretStore,
  sessionOverrides: Record<string, "saved-in-session" | "skipped">,
): SecretStatus {
  const override = sessionOverrides[slotName];
  if (override) return override;
  try {
    if (store.exists(slotName)) return "present";
  } catch {
    /* secret-store transient errors should not block setup */
  }
  return "missing";
}

function mergeStatus(a: SecretStatus, b: SecretStatus): SecretStatus {
  // Priority — most-demanding wins. The wizard cares about whether
  // ANY agent can't proceed.
  const order: SecretStatus[] = [
    "missing",
    "skipped",
    "saved-in-session",
    "present",
  ];
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}

function defaultModel(foremanProvider: string): string {
  // #419 — Delegate to the resolver's data-driven lookup
  // (registry/providers.json default_model field). Keeps the default
  // table in one place — no more duplicated hardcoded maps.
  return deriveDefaultModelId(foremanProvider);
}
