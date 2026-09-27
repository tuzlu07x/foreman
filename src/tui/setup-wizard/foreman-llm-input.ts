import type { Key } from "ink";
import {
  discoverModels,
  ModelDiscoveryError,
} from "../../core/llm/models-discovery.js";
import { canRunModel } from "../../core/ollama-models.js";
import type { WizardContext } from "./context.js";
import {
  BRAIN_DEFAULT_MODELS,
  brainPickerChoices,
  brainPickerCursor,
  persistForemanLlmChoice,
  resolveBrainModelSource,
} from "./foreman-llm-logic.js";
import { configuredBrainProviderIds } from "./shared.js";

// Foreman's-brain step (Step 2) key handling. Returns true when the key
// was consumed (the original handler `return`ed), false to fall through.
export function handleForemanLlmInput(
  ctx: WizardContext,
  input: string,
  key: Key,
): boolean {
  const {
    services,
    currentStep,
    advance,
    uncomplete,
    providerCatalog,
    machineCap,
    ollamaModelDoc,
    llmPresetDoc,
    ollamaDetection,
  } = ctx;
  const {
    foremanLlmPhase,
    foremanLlmDraft,
    cloudModelProvider,
    cloudModelOptions,
    cloudModelDraft,
    ollamaModelDraft,
    presetDraft,
    providersSignedIn,
  } = ctx.state;
  const {
    setForemanLlmPhase,
    setForemanLlmDraft,
    setCloudModelProvider,
    setCloudModelOptions,
    setCloudModelError,
    setCloudModelInfo,
    setCloudModelDraft,
    setOllamaModelDraft,
    setPresetDraft,
    setPresetKeyDraft,
  } = ctx.set;
  // #367 — Foreman's-LLM step key handling. Each phase has its own
  // ↑↓ cursor + Space/Enter commit + Esc back-out.
  if (currentStep === "foreman-llm") {
    const storedNames = new Set(
      services.secretStore.list().map((s) => s.name),
    );
    // #575 — API keys AND subscription sign-ins, exactly as rendered.
    const configured = configuredBrainProviderIds(
      providerCatalog,
      storedNames,
      providersSignedIn,
    );

    // ----- picker phase -----
    if (foremanLlmPhase === "picker") {
      // #370 — Disabled cloud rows are rendered but skipped here so
      // ↑↓ nav cycles only the actionable rows; Enter on a disabled
      // row is a no-op (the warning hint is rendered separately).
      const visible = brainPickerChoices(configured);
      const cursor = brainPickerCursor(foremanLlmDraft, visible);
      const idx = Math.max(0, visible.indexOf(cursor));
      if (key.upArrow) {
        setForemanLlmDraft(
          visible[(idx - 1 + visible.length) % visible.length] ?? null,
        );
        return true;
      }
      if (key.downArrow) {
        setForemanLlmDraft(visible[(idx + 1) % visible.length] ?? null);
        return true;
      }
      if (key.escape) {
        // Send the user back to providers — uncompleted providers state
        // re-renders Step 1 with their current saves.
        uncomplete("providers");
        return true;
      }
      if (key.return || input === " ") {
        const chosen = cursor;
        if (chosen === "ollama") {
          if (!ollamaDetection.installed) {
            setForemanLlmPhase("ollama-not-installed");
          } else {
            setForemanLlmPhase("ollama-model");
          }
          return true;
        }
        if (chosen === "preset") {
          setForemanLlmPhase("preset-pick");
          return true;
        }
        // #399 — Cloud providers go through the live model picker so
        // users can pick e.g. gpt-5.4-mini instead of the hardcoded
        // gpt-4o-mini default. Skip stays on the immediate-persist path.
        if (
          chosen === "openai" ||
          chosen === "anthropic" ||
          chosen === "gemini"
        ) {
          setCloudModelProvider(chosen);
          setCloudModelOptions(null);
          setCloudModelError(null);
          setCloudModelInfo(null);
          setCloudModelDraft(null);
          setForemanLlmPhase("cloud-model");
          // Kick off async fetch — wizard renders the loading state in
          // the meantime. We don't await here: useInput must stay
          // synchronous, and the discovery cache means re-entries are
          // cheap.
          void (async (): Promise<void> => {
            const source = resolveBrainModelSource(
              chosen,
              services.secretStore,
              providersSignedIn,
            );
            if (source.kind === "no-listing") {
              setCloudModelInfo(source.message);
              setCloudModelOptions([]);
              return;
            }
            if (source.kind === "missing") {
              setCloudModelError(source.message);
              setCloudModelOptions([]);
              return;
            }
            try {
              const models =
                source.kind === "api-key"
                  ? await discoverModels(chosen, { apiKey: source.apiKey })
                  : await discoverModels(chosen, {
                      apiKey: await source.accessToken(),
                      auth: "oauth",
                    });
              if (models.length === 0) {
                setCloudModelError(
                  `${chosen} returned no chat-capable models for this ${source.kind === "api-key" ? "key" : "sign-in"}.`,
                );
              }
              setCloudModelOptions(models);
            } catch (err) {
              const msg =
                err instanceof ModelDiscoveryError
                  ? err.message
                  : err instanceof Error
                    ? err.message
                    : String(err);
              setCloudModelError(
                source.kind === "oauth"
                  ? `Couldn't list models with your Claude sign-in (${msg}). Press [Enter] to use the default model (${BRAIN_DEFAULT_MODELS[chosen]}).`
                  : msg,
              );
              setCloudModelOptions([]);
            }
          })();
          return true;
        }
        // skip — persist directly + advance
        persistForemanLlmChoice({
          services,
          choice: chosen,
          ollamaModel: null,
          preset: null,
          presetKey: "",
        });
        setForemanLlmPhase("picker");
        setForemanLlmDraft(null);
        advance("foreman-llm");
        return true;
      }
    }

    // ----- #399 cloud-model phase -----
    // After the user picks a cloud provider, this phase fetches the
    // real model list. Loading + error states accept Enter to fall
    // back to the registry default; Esc returns to the picker.
    if (foremanLlmPhase === "cloud-model") {
      if (key.escape) {
        setForemanLlmPhase("picker");
        setCloudModelProvider(null);
        setCloudModelOptions(null);
        setCloudModelError(null);
        setCloudModelInfo(null);
        setCloudModelDraft(null);
        return true;
      }
      // While loading there's nothing actionable except Esc.
      if (cloudModelOptions === null) return true;
      // Error path: Enter accepts the default + advances. No model to
      // pick because the fetch failed; we persist with cloudModel=null
      // so persistForemanLlmChoice falls back to the hardcoded id.
      if (cloudModelOptions.length === 0) {
        if (key.return) {
          if (cloudModelProvider) {
            persistForemanLlmChoice({
              services,
              choice: cloudModelProvider,
              ollamaModel: null,
              preset: null,
              presetKey: "",
            });
          }
          setForemanLlmPhase("picker");
          setCloudModelProvider(null);
          setCloudModelOptions(null);
          setCloudModelError(null);
          setCloudModelInfo(null);
          setCloudModelDraft(null);
          setForemanLlmDraft(null);
          advance("foreman-llm");
        }
        return true;
      }
      // Picker active — drive the cursor through cloudModelOptions.
      const cursor =
        cloudModelDraft ?? cloudModelOptions[0]?.id ?? null;
      const idx = cloudModelOptions.findIndex((m) => m.id === cursor);
      const safeIdx = idx < 0 ? 0 : idx;
      if (key.upArrow) {
        const len = cloudModelOptions.length;
        const next =
          cloudModelOptions[(safeIdx - 1 + len) % len]?.id ?? null;
        setCloudModelDraft(next);
        return true;
      }
      if (key.downArrow) {
        const len = cloudModelOptions.length;
        const next = cloudModelOptions[(safeIdx + 1) % len]?.id ?? null;
        setCloudModelDraft(next);
        return true;
      }
      if (key.return || input === " ") {
        if (cloudModelProvider && cursor) {
          persistForemanLlmChoice({
            services,
            choice: cloudModelProvider,
            ollamaModel: null,
            preset: null,
            presetKey: "",
            cloudModel: cursor,
          });
        }
        setForemanLlmPhase("picker");
        setCloudModelProvider(null);
        setCloudModelOptions(null);
        setCloudModelError(null);
        setCloudModelInfo(null);
        setCloudModelDraft(null);
        setForemanLlmDraft(null);
        advance("foreman-llm");
        return true;
      }
    }

    // ----- ollama-not-installed phase -----
    if (foremanLlmPhase === "ollama-not-installed") {
      if (key.escape) {
        setForemanLlmPhase("picker");
        return true;
      }
      if (key.return) {
        // Re-check on Enter — `ollamaDetection` re-runs every phase
        // change, so if user installed it in another terminal we pick
        // it up on next phase transition.
        if (ollamaDetection.installed) {
          setForemanLlmPhase("ollama-model");
        } else {
          // Force a re-render by toggling phase. detectOllama() runs
          // again because foremanLlmPhase is in its deps.
          setForemanLlmPhase("picker");
          setTimeout(() => setForemanLlmPhase("ollama-not-installed"), 0);
        }
        return true;
      }
    }

    // ----- ollama-model phase -----
    if (foremanLlmPhase === "ollama-model") {
      const enabled = ollamaModelDoc.models.filter((m) => {
        const status = canRunModel(m, machineCap);
        return (
          status.state !== "disabled-ram" && status.state !== "disabled-disk"
        );
      });
      if (enabled.length === 0) {
        if (key.escape) setForemanLlmPhase("picker");
        return true;
      }
      const cursor = ollamaModelDraft ?? enabled[0]?.name ?? "";
      const idx = Math.max(0, enabled.findIndex((m) => m.name === cursor));
      if (key.upArrow) {
        setOllamaModelDraft(
          enabled[(idx - 1 + enabled.length) % enabled.length]?.name ?? null,
        );
        return true;
      }
      if (key.downArrow) {
        setOllamaModelDraft(
          enabled[(idx + 1) % enabled.length]?.name ?? null,
        );
        return true;
      }
      if (key.escape) {
        setForemanLlmPhase("picker");
        return true;
      }
      if (key.return || input === " ") {
        const chosen = enabled[idx]?.name;
        if (chosen) {
          persistForemanLlmChoice({
            services,
            choice: "ollama",
            ollamaModel: chosen,
            preset: null,
            presetKey: "",
          });
          setForemanLlmPhase("picker");
          setForemanLlmDraft(null);
          setOllamaModelDraft(null);
          advance("foreman-llm");
        }
        return true;
      }
    }

    // ----- preset-pick phase -----
    if (foremanLlmPhase === "preset-pick") {
      const presets = llmPresetDoc.presets;
      const cursor = presetDraft ?? presets[0]?.id ?? "";
      const idx = Math.max(0, presets.findIndex((p) => p.id === cursor));
      if (key.upArrow) {
        setPresetDraft(
          presets[(idx - 1 + presets.length) % presets.length]?.id ?? null,
        );
        return true;
      }
      if (key.downArrow) {
        setPresetDraft(presets[(idx + 1) % presets.length]?.id ?? null);
        return true;
      }
      if (key.escape) {
        setForemanLlmPhase("picker");
        return true;
      }
      if (key.return || input === " ") {
        const chosen = presets[idx];
        if (chosen) {
          setPresetDraft(chosen.id);
          setForemanLlmPhase("preset-key");
        }
        return true;
      }
    }

    // preset-key — handled by the PasswordInput's onSubmit. Esc back-out:
    if (foremanLlmPhase === "preset-key") {
      if (key.escape) {
        setForemanLlmPhase("preset-pick");
        setPresetKeyDraft("");
        return true;
      }
    }
  }
  return false;
}
