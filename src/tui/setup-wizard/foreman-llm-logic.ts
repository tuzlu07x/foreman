import { loadLlmConfig, saveLlmConfig } from "../../core/llm/config.js";
import type { LlmPreset } from "../../core/llm-provider-presets.js";
import {
  isOAuthProviderId,
  type OAuthProviderId,
} from "../../core/llm/oauth/oauth-providers.js";
import { makeAccessTokenProvider } from "../../core/llm/oauth/token-refresh.js";
import { loadOAuthTokens } from "../../core/llm/oauth/token-store.js";
import type { OllamaModel, RunStatus } from "../../core/ollama-models.js";
import type { SecretStore } from "../../core/secret-store.js";
import type { WizardServices } from "./types.js";

// #367 — Foreman's-LLM step sub-phases. `picker` is the universal choice;
// `ollama-*` and `preset-*` are sub-flows the user enters from the picker.
export type ForemanLlmPhase =
  | "picker"
  | "cloud-model"
  | "ollama-not-installed"
  | "ollama-model"
  | "preset-pick"
  | "preset-key";

// Stable ids for the universal picker rows. Cloud ids match provider
// catalog ids; `ollama`, `preset`, `skip` are wizard-level sentinels.
export type ForemanLlmChoice =
  | "anthropic"
  | "openai"
  | "gemini"
  | "ollama"
  | "preset"
  | "skip";

export type BrainCloudProvider = "anthropic" | "openai" | "gemini";

/** The picker rows the cursor can land on, in display order. `configured`
 *  must be `configuredBrainProviderIds(...)` — the same set the render uses
 *  to grey rows out — so what's drawn and what Enter acts on can't diverge
 *  (they did before: #575 widened the render to count sign-ins, but the key
 *  handler still counted API keys only). */
export function brainPickerChoices(
  configured: ReadonlySet<string>,
): ForemanLlmChoice[] {
  const choices: ForemanLlmChoice[] = [];
  for (const id of ["anthropic", "openai", "gemini"] as const) {
    if (configured.has(id)) choices.push(id);
  }
  choices.push("ollama", "preset", "skip");
  return choices;
}

/** The row the cursor is on: the draft when it's still selectable, else
 *  the first selectable row. */
export function brainPickerCursor(
  draft: string | null,
  choices: readonly ForemanLlmChoice[],
): ForemanLlmChoice {
  const fromDraft = choices.find((c) => c === draft);
  return fromDraft ?? choices[0] ?? "skip";
}

/** Model persisted when the user doesn't (or can't) pick one from the live
 *  list — e.g. discovery failed or the sign-in has no model list. */
export const BRAIN_DEFAULT_MODELS: Record<BrainCloudProvider, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
};

const SUBSCRIPTION_LABEL: Record<OAuthProviderId, string> = {
  anthropic: "Claude",
  openai: "ChatGPT",
};

/**
 * #575 follow-up — how the brain step can list models for a cloud provider.
 * A provider shows up as usable in the picker when it has an API key, a
 * sign-in chosen this wizard run, or OAuth tokens from an earlier
 * `foreman llm login` (`configuredBrainProviderIds`); model discovery has to
 * honour the same three sources instead of insisting on `<provider>-key`.
 *
 * - `api-key` / `oauth`: list models with that credential. Only Anthropic
 *   accepts a subscription token for listing.
 * - `no-listing`: the provider is usable but there is nothing to list with
 *   (sign-in still pending until after the wizard, or a ChatGPT sign-in,
 *   whose backend has no model list). Enter keeps the default model.
 * - `missing`: nothing configured at all.
 */
export type BrainModelSource =
  | { kind: "api-key"; apiKey: string }
  | { kind: "oauth"; accessToken: () => Promise<string> }
  | { kind: "no-listing"; message: string }
  | { kind: "missing"; message: string };

export function resolveBrainModelSource(
  provider: BrainCloudProvider,
  secretStore: SecretStore,
  signedInThisSession: readonly OAuthProviderId[],
): BrainModelSource {
  const keySecret = `${provider}-key`;
  const defaultModel = BRAIN_DEFAULT_MODELS[provider];
  const keepDefault = `Press [Enter] to use the default model (${defaultModel}); change \`model:\` in llm.yaml any time.`;
  const oauthId = isOAuthProviderId(provider) ? provider : null;
  const hasTokens =
    oauthId !== null && loadOAuthTokens(secretStore, oauthId) !== null;

  if (oauthId && signedInThisSession.includes(oauthId) && !hasTokens) {
    return {
      kind: "no-listing",
      message:
        `You'll sign in with your ${SUBSCRIPTION_LABEL[oauthId]} subscription after setup ` +
        `(\`foreman llm login ${oauthId}\`), so there is no model list to show yet. ${keepDefault}`,
    };
  }
  if (secretStore.exists(keySecret)) {
    return { kind: "api-key", apiKey: secretStore.get(keySecret) };
  }
  if (oauthId === "anthropic" && hasTokens) {
    const tokens = makeAccessTokenProvider(secretStore, "anthropic");
    return {
      kind: "oauth",
      accessToken: async () => (await tokens()).accessToken,
    };
  }
  if (oauthId === "openai" && hasTokens) {
    return {
      kind: "no-listing",
      message: `Your ChatGPT sign-in doesn't offer a model list. ${keepDefault}`,
    };
  }
  return {
    kind: "missing",
    message:
      oauthId !== null
        ? `No ${keySecret} and no ${SUBSCRIPTION_LABEL[oauthId]} sign-in — go back, add one in Step 1, then return here.`
        : `No ${keySecret} in the secret store — go back, set it in Step 1, then return here.`,
  };
}

// Format the trailing tag for an Ollama model row in the wizard's picker.
// `[recommended]` / `[balanced]` / `[tight — N%]` for enabled rows;
// `[installed]` appended when the model is already pulled locally.
export function formatOllamaRunTag(
  model: OllamaModel,
  status: RunStatus,
  installedModels: readonly string[],
): string {
  const installed = installedModels.includes(model.name);
  const parts: string[] = [];
  if (status.state === "recommended") {
    if (model.recommended) parts.push("[recommended]");
  } else if (status.state === "balanced") {
    parts.push("[balanced]");
  } else if (status.state === "tight") {
    parts.push(`[tight — ${status.ramPct}% RAM]`);
  }
  if (installed) parts.push("[installed]");
  return parts.length > 0 ? "  " + parts.join(" ") : "";
}

// #367 — Persist the user's explicit Foreman-LLM choice from the new
// Step 2. Sets `provider` + `model` to the picked path, flips
// `features.verification + smart_report` on (off when user picked
// "Skip"), and wires preset credentials into `credentials.openai_compatible`.
// For preset choices, also writes the user's API key to the secret store.
export function persistForemanLlmChoice(args: {
  services: WizardServices;
  choice: ForemanLlmChoice;
  ollamaModel: string | null;
  preset: LlmPreset | null;
  presetKey: string;
  /** #399 — When set, overrides the hardcoded default for cloud choices.
   *  Bare model id (e.g. `gpt-5.4-mini`, not `openai/gpt-5.4-mini`). */
  cloudModel?: string | null;
}): void {
  try {
    const existing = loadLlmConfig(args.services.llmConfigPath);
    const next = { ...existing };

    if (args.choice === "skip") {
      next.enabled = false;
      next.features = {
        ...existing.features,
        verification: false,
        smart_report: false,
      };
      saveLlmConfig(args.services.llmConfigPath, next);
      return;
    }

    next.enabled = true;
    next.features = {
      ...existing.features,
      verification: true,
      smart_report: true,
      // #498 — Default orchestrator_chat ON when the wizard configures
      // Foreman's LLM. Without it, free-form "foreman are you there?"
      // returns "Unknown command" — a UX cliff users hit immediately
      // in QA. Budget guardrails still apply (monthly_cap_usd, alert
      // threshold) so the opt-in cost concern doesn't disappear, the
      // user just doesn't have to hand-edit YAML to talk to Foreman.
      orchestrator_chat: true,
    };

    if (args.choice === "anthropic") {
      next.provider = "anthropic";
      next.model = args.cloudModel ?? BRAIN_DEFAULT_MODELS.anthropic;
    } else if (args.choice === "openai") {
      next.provider = "openai";
      next.model = args.cloudModel ?? BRAIN_DEFAULT_MODELS.openai;
    } else if (args.choice === "gemini") {
      next.provider = "gemini";
      next.model = args.cloudModel ?? BRAIN_DEFAULT_MODELS.gemini;
    } else if (args.choice === "ollama" && args.ollamaModel) {
      next.provider = "ollama";
      next.model = args.ollamaModel;
      next.credentials = {
        ...existing.credentials,
        ollama: {
          ...(existing.credentials.ollama ?? {}),
          auth_mode:
            existing.credentials.ollama?.auth_mode ?? "api_key",
          endpoint: existing.credentials.ollama?.endpoint ??
            "http://localhost:11434",
          secret_name: null,
        },
      };
    } else if (args.choice === "preset" && args.preset) {
      next.provider = "openai_compatible";
      next.model = args.preset.default_model;
      next.credentials = {
        ...existing.credentials,
        openai_compatible: {
          auth_mode:
            existing.credentials.openai_compatible?.auth_mode ?? "api_key",
          endpoint_secret: `${args.preset.id}-endpoint`,
          key_secret: args.preset.key_secret_name,
        },
      };
      // Save the API key + endpoint URL to the secret store so the
      // openai_compatible client can resolve them at call time. Use
      // rotate when the secret already exists (user re-runs the wizard).
      const upsertSecret = (name: string, value: string): void => {
        try {
          args.services.secretStore.add(name, value);
        } catch {
          try {
            args.services.secretStore.rotate(name, value);
          } catch (err) {
            console.error(
              `⚠ failed to save secret ${name}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      };
      upsertSecret(args.preset.key_secret_name, args.presetKey);
      upsertSecret(`${args.preset.id}-endpoint`, args.preset.endpoint);
    }

    saveLlmConfig(args.services.llmConfigPath, next);
  } catch (err) {
    console.error(
      `⚠ failed to persist Foreman-LLM choice: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
