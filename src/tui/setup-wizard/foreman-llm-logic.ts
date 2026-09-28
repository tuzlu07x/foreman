import { loadLlmConfig, saveLlmConfig } from "../../core/llm/config.js";
import {
  checkLlmBaseUrl,
  OLLAMA_DEFAULT_BASE_URL,
} from "../../core/llm/endpoint.js";
import {
  discoverModels,
  type DiscoveredModel,
} from "../../core/llm/models-discovery.js";
import type { LlmPreset } from "../../core/llm-provider-presets.js";
import type { MachineCapability } from "../../core/machine-capability.js";
import {
  isOAuthProviderId,
  type OAuthProviderId,
} from "../../core/llm/oauth/oauth-providers.js";
import { makeAccessTokenProvider } from "../../core/llm/oauth/token-refresh.js";
import { loadOAuthTokens } from "../../core/llm/oauth/token-store.js";
import {
  canRunModel,
  type OllamaModel,
  type OllamaModelDoc,
  type RunStatus,
} from "../../core/ollama-models.js";
import { deriveDefaultModelId } from "../../core/provider-resolver.js";
import type { SecretStore } from "../../core/secret-store.js";
import { classifyModelDiscoveryError } from "./agents-logic.js";
import type { WizardContext } from "./context.js";
import type { WizardSetters } from "./state.js";
import type { WizardServices } from "./types.js";

// #367 — Foreman's-LLM step sub-phases. `picker` is the universal choice;
// `ollama-*`, `preset-*`, `custom-*` and `compat-model` are sub-flows the
// user enters from the picker. `compat-model` picks the model for both a
// preset and a custom OpenAI-compatible endpoint.
export type ForemanLlmPhase =
  | "picker"
  | "cloud-model"
  | "ollama-url"
  | "ollama-model"
  | "preset-pick"
  | "preset-key"
  | "custom-url"
  | "custom-key"
  | "compat-model";

// Stable ids for the universal picker rows. Cloud ids match provider
// catalog ids; `ollama`, `preset`, `skip` are wizard-level sentinels.
// `custom` is the "own endpoint" entry under the preset list.
export type ForemanLlmChoice =
  | "anthropic"
  | "openai"
  | "gemini"
  | "ollama"
  | "preset"
  | "custom"
  | "skip";

export type BrainCloudProvider = "anthropic" | "openai" | "gemini";

/** Preset-list id of the "your own endpoint" row; no preset uses it. */
export const CUSTOM_ENDPOINT_ID = "custom-endpoint";

/** Secret slots a custom OpenAI-compatible brain is stored under — the
 *  names llm.yaml defaults to and Step 1's "Custom OpenAI-compatible"
 *  provider writes, so the Providers page manages the same values. */
export const CUSTOM_ENDPOINT_SECRET = "openai-compatible-endpoint";
export const CUSTOM_KEY_SECRET = "openai-compatible-key";

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
  anthropic: registryDefault("anthropic", "claude-haiku-4-5"),
  openai: registryDefault("openai", "gpt-6-luna"),
  gemini: registryDefault("gemini", "gemini-3.5-flash-lite"),
};

/** registry/providers.json's default_model, or `fallback` if it can't be read. */
function registryDefault(provider: string, fallback: string): string {
  const id = deriveDefaultModelId(provider);
  return id === "default" ? fallback : id;
}

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

/** Pre-filled Ollama base URL: the one the brain already uses (Step 1's
 *  `ollama-endpoint` secret or llm.yaml's `endpoint`), else the local
 *  default. */
export function initialOllamaBaseUrl(services: WizardServices): string {
  try {
    const cred = loadLlmConfig(services.llmConfigPath).credentials.ollama;
    if (cred?.endpoint_secret && services.secretStore.exists(cred.endpoint_secret)) {
      return services.secretStore.get(cred.endpoint_secret);
    }
    if (cred?.endpoint) return cred.endpoint;
  } catch {
    /* unreadable llm.yaml — fall back to the default */
  }
  return OLLAMA_DEFAULT_BASE_URL;
}

/** Pre-filled custom endpoint: the stored one, if any. */
export function initialCustomBaseUrl(secretStore: SecretStore): string {
  try {
    if (secretStore.exists(CUSTOM_ENDPOINT_SECRET)) {
      return secretStore.get(CUSTOM_ENDPOINT_SECRET);
    }
  } catch {
    /* fall through */
  }
  return "";
}

export interface OllamaModelRow {
  name: string;
  /** Size / description / tags shown after the name. */
  detail: string;
  /** Already on the server; a row that isn't needs `ollama pull` first. */
  pulled: boolean;
}

/**
 * Rows for the Ollama model picker. Models pulled on the server (live
 * `/api/tags`) come first. For a server on this machine, the bundled
 * catalog follows: models that fit are selectable (they need an
 * `ollama pull`), models that don't are listed disabled with the reason.
 * A remote server only offers what it has pulled — this machine's RAM says
 * nothing about it.
 */
export function ollamaModelRows(args: {
  live: readonly DiscoveredModel[];
  catalog: OllamaModelDoc;
  machine: MachineCapability;
  local: boolean;
}): { selectable: OllamaModelRow[]; disabled: OllamaModelRow[] } {
  const pulled = args.live.map((m) => m.id);
  const isPulled = (name: string): boolean =>
    pulled.includes(name) ||
    pulled.includes(`${name}:latest`) ||
    pulled.includes(name.replace(/:latest$/, ""));
  const catalogEntry = (name: string): OllamaModel | undefined =>
    args.catalog.models.find(
      (m) => m.name === name || `${m.name}:latest` === name,
    );
  const describe = (model: OllamaModel): string =>
    `${model.runtime_ram_gb.toFixed(1).padStart(5, " ")} GB · ${model.description}`;

  const selectable: OllamaModelRow[] = pulled.map((name) => {
    const entry = catalogEntry(name);
    return {
      name,
      detail: entry ? `${describe(entry)}  [installed]` : "[installed]",
      pulled: true,
    };
  });
  const disabled: OllamaModelRow[] = [];
  if (!args.local) return { selectable, disabled };
  for (const model of args.catalog.models) {
    if (isPulled(model.name)) continue;
    const status = canRunModel(model, args.machine);
    if (status.state === "disabled-ram" || status.state === "disabled-disk") {
      disabled.push({
        name: model.name,
        detail: `${model.runtime_ram_gb.toFixed(0).padStart(4, " ")} GB · ✗ ${status.reason}`,
        pulled: false,
      });
      continue;
    }
    selectable.push({
      name: model.name,
      detail: `${describe(model)}${formatOllamaRunTag(model, status, [])}  [needs ollama pull]`,
      pulled: false,
    });
  }
  return { selectable, disabled };
}

/** Where a self-hosted model list came from, for error wording. */
export interface SelfHostedTarget {
  kind: "ollama" | "preset" | "custom";
  /** "Ollama", the preset's name, or "your endpoint". */
  label: string;
  baseUrl: string;
}

export function selfHostedTarget(
  kind: SelfHostedTarget["kind"],
  baseUrl: string,
  preset: LlmPreset | null,
): SelfHostedTarget {
  const label =
    kind === "ollama" ? "Ollama" : (preset?.name ?? "your endpoint");
  return { kind, label, baseUrl };
}

/** A preset's own default model first, then the rest as listed. */
export function orderCompatModels(
  models: readonly DiscoveredModel[],
  defaultModel: string | undefined,
): DiscoveredModel[] {
  const first = models.filter((m) => m.id === defaultModel);
  return [...first, ...models.filter((m) => m.id !== defaultModel)];
}

/** classifyModelDiscoveryError for self-hosted brains: a refused
 *  connection is a server that isn't running, not a missing internet
 *  connection, and a 404 / non-JSON reply is usually the wrong base URL. */
export function classifyBrainDiscoveryError(
  rawMessage: string,
  target: SelfHostedTarget,
): string {
  const status = Number(rawMessage.match(/^HTTP (\d{3})/)?.[1] ?? NaN);
  if (status === 401 || status === 403) {
    return target.kind === "ollama"
      ? `Ollama at ${target.baseUrl} refused the request (HTTP ${status}). Check the URL, or press [Esc] to go back.`
      : `${target.label} rejected the API key (HTTP ${status}). Press [Esc] to re-enter it.`;
  }
  if (/abort|timeout|network|fetch failed|ECONNREFUSED/i.test(rawMessage)) {
    return target.kind === "ollama"
      ? `Couldn't reach Ollama at ${target.baseUrl} — start it with \`ollama serve\`, or press [Esc] to change the URL.`
      : `Couldn't reach ${target.label} at ${target.baseUrl} — check the URL and your connection.`;
  }
  if (status === 404 || /^Malformed response/.test(rawMessage)) {
    if (target.kind === "ollama") {
      return `${target.baseUrl} answered, but not like an Ollama server — check the URL.`;
    }
    return target.kind === "custom" && !/\/v\d+$/.test(target.baseUrl)
      ? `${target.baseUrl} answered, but not with a model list — an OpenAI-compatible base URL usually ends in /v1.`
      : `${target.baseUrl} answered, but has no model list at /models.`;
  }
  if (/^Invalid base URL/.test(rawMessage)) return rawMessage;
  return classifyModelDiscoveryError(rawMessage, target.label);
}

/** Fetch a self-hosted brain's model list into cloudModelOptions (null
 *  while loading; [] plus cloudModelError on failure). Uncached so a
 *  re-check right after `ollama pull` sees the new model. */
export function startSelfHostedDiscovery(
  set: WizardSetters,
  target: SelfHostedTarget,
  apiKey: string,
): void {
  set.setCloudModelOptions(null);
  set.setCloudModelError(null);
  set.setCloudModelInfo(null);
  set.setCloudModelDraft(null);
  const provider = target.kind === "ollama" ? "ollama" : "openai_compatible";
  void (async (): Promise<void> => {
    try {
      const models = await discoverModels(provider, {
        apiKey,
        baseUrl: target.baseUrl,
        cacheTtlMs: 0,
      });
      set.setCloudModelOptions(models);
    } catch (err) {
      set.setCloudModelError(
        classifyBrainDiscoveryError(
          err instanceof Error ? err.message : String(err),
          target,
        ),
      );
      set.setCloudModelOptions([]);
    }
  })();
}

/** Forget a self-hosted sub-flow's drafts (URL, key, model list). */
export function resetSelfHostedDrafts(set: WizardSetters): void {
  set.setBrainBaseUrl(null);
  set.setBrainBaseUrlError(null);
  set.setPresetKeyDraft("");
  set.setOllamaModelDraft(null);
  set.setCloudModelOptions(null);
  set.setCloudModelError(null);
  set.setCloudModelDraft(null);
}

/** After a brain is saved: back to the picker and on to the next step. */
export function finishBrainStep(ctx: WizardContext): void {
  resetSelfHostedDrafts(ctx.set);
  ctx.set.setForemanLlmPhase("picker");
  ctx.set.setForemanLlmDraft(null);
  ctx.advance("foreman-llm");
}

/** Validate a typed base URL for the wizard; the error names the rule. */
export function validateBrainBaseUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; message: string } {
  const checked = checkLlmBaseUrl(raw);
  return checked.ok
    ? { ok: true, url: checked.url }
    : { ok: false, message: `Not a usable base URL: ${checked.reason}.` };
}

// #367 — Persist the user's explicit Foreman-LLM choice from the new
// Step 2. Sets `provider` + `model` to the picked path, flips
// `features.verification + smart_report` on (off when user picked
// "Skip"), and wires preset credentials into `credentials.openai_compatible`.
// For preset choices, also writes the user's API key to the secret store.
// A custom endpoint stores its URL (and key, when given) under the
// Step 1 "Custom OpenAI-compatible" slots.
export function persistForemanLlmChoice(args: {
  services: WizardServices;
  choice: ForemanLlmChoice;
  ollamaModel: string | null;
  preset: LlmPreset | null;
  /** API key for a preset or a custom endpoint; empty = keyless custom. */
  presetKey: string;
  /** #399 — When set, overrides the hardcoded default for cloud choices,
   *  and the preset default for a preset. Bare model id (e.g.
   *  `gpt-5.4-mini`, not `openai/gpt-5.4-mini`). Required for `custom`. */
  cloudModel?: string | null;
  /** Validated base URL for `ollama` (default: the existing endpoint or
   *  http://localhost:11434) and `custom` (required). */
  baseUrl?: string | null;
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
      const ollama = { ...(existing.credentials.ollama ?? {}) };
      // The URL typed here is the one the brain uses: drop Step 1's
      // endpoint_secret, which the factory would otherwise prefer.
      delete ollama.endpoint_secret;
      next.credentials = {
        ...existing.credentials,
        ollama: {
          ...ollama,
          auth_mode: ollama.auth_mode ?? "api_key",
          endpoint:
            args.baseUrl ?? ollama.endpoint ?? OLLAMA_DEFAULT_BASE_URL,
          secret_name: null,
        },
      };
    } else if (args.choice === "preset" && args.preset) {
      next.provider = "openai_compatible";
      next.model = args.cloudModel ?? args.preset.default_model;
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
      // openai_compatible client can resolve them at call time.
      upsertSecret(args.services.secretStore, args.preset.key_secret_name, args.presetKey);
      upsertSecret(args.services.secretStore, `${args.preset.id}-endpoint`, args.preset.endpoint);
    } else if (args.choice === "custom" && args.baseUrl && args.cloudModel) {
      next.provider = "openai_compatible";
      next.model = args.cloudModel;
      const key = args.presetKey.trim();
      next.credentials = {
        ...existing.credentials,
        openai_compatible: {
          auth_mode: "api_key",
          endpoint_secret: CUSTOM_ENDPOINT_SECRET,
          // No key given: a keyless server. Leaving key_secret out keeps the
          // factory from sending (or requiring) a stale stored key.
          ...(key.length > 0 ? { key_secret: CUSTOM_KEY_SECRET } : {}),
        },
      };
      upsertSecret(args.services.secretStore, CUSTOM_ENDPOINT_SECRET, args.baseUrl);
      if (key.length > 0) upsertSecret(args.services.secretStore, CUSTOM_KEY_SECRET, key);
    }

    saveLlmConfig(args.services.llmConfigPath, next);
  } catch (err) {
    console.error(
      `⚠ failed to persist Foreman-LLM choice: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Add, or rotate when the secret already exists (the user re-runs the
// wizard).
function upsertSecret(store: SecretStore, name: string, value: string): void {
  try {
    store.add(name, value);
  } catch {
    try {
      store.rotate(name, value);
    } catch (err) {
      console.error(
        `⚠ failed to save secret ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
