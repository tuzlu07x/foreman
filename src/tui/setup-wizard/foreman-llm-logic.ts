import { loadLlmConfig, saveLlmConfig } from "../../core/llm/config.js";
import type { LlmPreset } from "../../core/llm-provider-presets.js";
import type { OllamaModel, RunStatus } from "../../core/ollama-models.js";
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
      next.model = args.cloudModel ?? "claude-haiku-4-5-20251001";
    } else if (args.choice === "openai") {
      next.provider = "openai";
      next.model = args.cloudModel ?? "gpt-4o-mini";
    } else if (args.choice === "gemini") {
      next.provider = "gemini";
      next.model = args.cloudModel ?? "gemini-2.0-flash";
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
