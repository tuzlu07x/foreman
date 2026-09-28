import {
  defaultLlmConfig,
  loadLlmConfig,
  saveLlmConfig,
} from "../../core/llm/config.js";
import type { ProviderEntry } from "../../core/registry-catalog.js";
import { buildLlmConfigFromWizard } from "../setup-wizard-llm-persist.js";
import { validateKeyPaste } from "../setup-wizard-key-validation.js";
import { endpointPasteWarning } from "./paste-checks.js";
import type { WizardServices } from "./types.js";

export type ProvidersPhase = "picker" | "values" | "summary";

export interface ProvidersPickerSubmitResult {
  nextPhase: ProvidersPhase;
  selected: string[];
}

export function applyProvidersPickerSubmit(
  values: string[],
): ProvidersPickerSubmitResult {
  if (values.length === 0) {
    return { nextPhase: "summary", selected: [] };
  }
  return { nextPhase: "values", selected: values };
}

export type ProviderPromptKind = "endpoint" | "key";

export interface ProviderPrompt {
  providerId: string;
  kind: ProviderPromptKind;
}

// Flattens (provider × required-fields) into the ordered list of input
// screens the wizard will walk through. Anthropic/OpenAI/Gemini contribute
// a single "key" prompt; Ollama contributes a single "endpoint" prompt;
// the Custom OpenAI-compatible provider contributes endpoint THEN key.
export function buildProviderPromptList(
  providers: ProviderEntry[],
  selectedIds: string[],
): ProviderPrompt[] {
  const prompts: ProviderPrompt[] = [];
  for (const id of selectedIds) {
    const p = providers.find((x) => x.id === id);
    if (!p) continue;
    if (p.endpoint_required) prompts.push({ providerId: id, kind: "endpoint" });
    if (p.secret_name) prompts.push({ providerId: id, kind: "key" });
  }
  return prompts;
}

export function storageNameForPrompt(
  prompt: ProviderPrompt,
  provider: ProviderEntry,
): string {
  if (prompt.kind === "key") {
    if (!provider.secret_name) {
      throw new Error(
        `provider "${provider.id}" has no secret_name but kind === "key"`,
      );
    }
    return provider.secret_name;
  }
  return `${provider.id}-endpoint`;
}

export interface ProviderValueSubmitInput {
  prompt: ProviderPrompt;
  value: string;
  currentIdx: number;
  totalPrompts: number;
}

export interface ProviderValueSubmitResult {
  shouldSave: boolean;
  warning: string | null;
  nextPhase: ProvidersPhase;
  nextIdx: number;
}

export function applyProviderValueSubmit(
  input: ProviderValueSubmitInput,
): ProviderValueSubmitResult {
  const isLast = input.currentIdx + 1 >= input.totalPrompts;
  if (input.value.length === 0) {
    const label =
      input.prompt.kind === "endpoint"
        ? `${input.prompt.providerId} endpoint`
        : `${input.prompt.providerId} key`;
    return {
      shouldSave: false,
      warning: `Skipped ${label} — empty value. Add it later from the LLM Providers page.`,
      nextPhase: isLast ? "summary" : "values",
      nextIdx: input.currentIdx + 1,
    };
  }
  return {
    shouldSave: true,
    warning: null,
    nextPhase: isLast ? "summary" : "values",
    nextIdx: input.currentIdx + 1,
  };
}

// Side-effecting glue between the pure phase reducer and React state +
// SecretStore. Internal to the wizard (not re-exported from setup-wizard.tsx)
// because the call sites are only the two TextInput / PasswordInput
// onSubmits in providers.tsx that share this logic.
export function handleProviderValueSubmit(
  prompt: ProviderPrompt,
  provider: ProviderEntry,
  storageName: string,
  value: string,
  services: WizardServices,
  totalPrompts: number,
  currentIdx: number,
  setSaved: (fn: (prev: string[]) => string[]) => void,
  setSkipped: (fn: (prev: string[]) => string[]) => void,
  setWarning: (w: string | null) => void,
  setIdx: (n: number) => void,
  setPhase: (p: ProvidersPhase) => void,
): void {
  const result = applyProviderValueSubmit({
    prompt,
    value,
    currentIdx,
    totalPrompts,
  });
  if (result.shouldSave) {
    try {
      if (!services.secretStore.exists(storageName)) {
        services.secretStore.add(storageName, value);
      } else {
        services.secretStore.rotate(storageName, value);
      }
      // #341 — dedupe at the source so a re-save (user backed out + re-
      // entered the same prompt) doesn't append the name twice and
      // collide as a React key in the summary render.
      setSaved((prev) => (prev.includes(storageName) ? prev : [...prev, storageName]));
    } catch (err) {
      setWarning(
        `failed to store ${storageName}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  } else {
    setSkipped((prev) => (prev.includes(storageName) ? prev : [...prev, storageName]));
  }
  // Paste-time prefix validation (#291) — soft-warn after save when the
  // pasted key looks like it belongs to a different provider. We always
  // save (so the wizard never blocks progress on a possibly-private key)
  // but surface the warning so a cross-provider paste is caught in the
  // right context.
  let validationWarning: string | null = null;
  if (result.shouldSave && prompt.kind === "key") {
    const check = validateKeyPaste({ provider, value });
    if (!check.ok) validationWarning = check.warning;
  } else if (result.shouldSave && prompt.kind === "endpoint") {
    validationWarning = endpointPasteWarning(value);
  }
  setWarning(validationWarning ?? result.warning);
  setIdx(result.nextIdx);
  setPhase(result.nextPhase);
}

// Side-effecting glue: load llm.yaml (or seed defaults), merge in the
// providers the wizard wired up, write back. Idempotent — replaying the
// providers step doesn't double-write. Failures are surfaced as a console
// warning + the install-log block (#289 follow-up) but never crash the
// wizard, because then the user is stuck mid-setup with no way out.
export function persistLlmConfigFromWizardState(
  services: WizardServices,
  providerCatalog: ProviderEntry[],
  savedStorageNames: string[],
  signedInProviders: ("anthropic" | "openai")[] = [],
): void {
  if (savedStorageNames.length === 0 && signedInProviders.length === 0) return;
  try {
    // loadLlmConfig falls back to defaults when the file doesn't exist, so
    // we always get a typed LlmConfig to merge into.
    const existing = loadLlmConfig(services.llmConfigPath);
    const { next, wiredProviders } = buildLlmConfigFromWizard({
      savedStorageNames,
      signedInProviders,
      providerCatalog,
      existing,
    });
    if (wiredProviders.length === 0) return;
    saveLlmConfig(services.llmConfigPath, next);
  } catch (err) {
    // Best-effort: if the merge fails (corrupt llm.yaml, disk error), fall
    // back to writing a fresh defaults-based config so the user isn't left
    // with NO config at all.
    try {
      const { next } = buildLlmConfigFromWizard({
        savedStorageNames,
        signedInProviders,
        providerCatalog,
        existing: defaultLlmConfig(),
      });
      saveLlmConfig(services.llmConfigPath, next);
    } catch (writeErr) {
      console.error(
        `⚠ failed to persist llm.yaml: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        `(original error: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
}
