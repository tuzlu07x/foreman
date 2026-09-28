import type { Key } from "ink";
import {
  discoverModels,
  ModelDiscoveryError,
} from "../../core/llm/models-discovery.js";
import { isLoopbackUrl } from "../../core/llm/endpoint.js";
import { findPreset } from "../../core/llm-provider-presets.js";
import type { WizardContext } from "./context.js";
import {
  BRAIN_DEFAULT_MODELS,
  brainPickerChoices,
  brainPickerCursor,
  CUSTOM_ENDPOINT_ID,
  finishBrainStep,
  ollamaModelRows,
  orderCompatModels,
  persistForemanLlmChoice,
  resetSelfHostedDrafts,
  resolveBrainModelSource,
  selfHostedTarget,
  startSelfHostedDiscovery,
} from "./foreman-llm-logic.js";
import { classifyModelDiscoveryError } from "./agents-logic.js";
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
  } = ctx;
  const {
    foremanLlmPhase,
    foremanLlmDraft,
    cloudModelProvider,
    cloudModelOptions,
    cloudModelDraft,
    ollamaModelDraft,
    presetDraft,
    presetKeyDraft,
    providersSignedIn,
    brainBaseUrl,
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
    setBrainBaseUrlError,
  } = ctx.set;
  const resetSelfHosted = (): void => resetSelfHostedDrafts(ctx.set);
  const finish = (): void => finishBrainStep(ctx);
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
          setBrainBaseUrlError(null);
          setForemanLlmPhase("ollama-url");
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
                  : classifyModelDiscoveryError(msg, chosen),
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

    // ----- ollama-url / custom-url / custom-key -----
    // Text entry is handled by the phase's input's onSubmit; only Esc here.
    if (foremanLlmPhase === "ollama-url") {
      if (key.escape) {
        resetSelfHosted();
        setForemanLlmPhase("picker");
      }
      return true;
    }
    if (foremanLlmPhase === "custom-url") {
      if (key.escape) {
        resetSelfHosted();
        setForemanLlmPhase("preset-pick");
      }
      return true;
    }
    if (foremanLlmPhase === "custom-key") {
      if (key.escape) {
        setPresetKeyDraft("");
        setBrainBaseUrlError(null);
        setForemanLlmPhase("custom-url");
      }
      return true;
    }

    // ----- ollama-model phase -----
    // Pulled models from the server first, then (for a local server) the
    // bundled catalog. [r] re-checks after an `ollama pull`.
    if (foremanLlmPhase === "ollama-model") {
      if (key.escape) {
        setCloudModelOptions(null);
        setCloudModelError(null);
        setOllamaModelDraft(null);
        setForemanLlmPhase("ollama-url");
        return true;
      }
      if (cloudModelOptions === null || !brainBaseUrl) return true;
      const target = selfHostedTarget("ollama", brainBaseUrl, null);
      if (input === "r") {
        startSelfHostedDiscovery(ctx.set, target, "");
        return true;
      }
      const { selectable } = ollamaModelRows({
        live: cloudModelOptions,
        catalog: ollamaModelDoc,
        machine: machineCap,
        local: isLoopbackUrl(brainBaseUrl),
      });
      if (selectable.length === 0) {
        if (key.return) startSelfHostedDiscovery(ctx.set, target, "");
        return true;
      }
      const idx = Math.max(
        0,
        selectable.findIndex((m) => m.name === ollamaModelDraft),
      );
      if (key.upArrow) {
        setOllamaModelDraft(
          selectable[(idx - 1 + selectable.length) % selectable.length]?.name ??
            null,
        );
        return true;
      }
      if (key.downArrow) {
        setOllamaModelDraft(
          selectable[(idx + 1) % selectable.length]?.name ?? null,
        );
        return true;
      }
      if (key.return || input === " ") {
        const chosen = selectable[idx]?.name;
        if (chosen) {
          persistForemanLlmChoice({
            services,
            choice: "ollama",
            ollamaModel: chosen,
            preset: null,
            presetKey: "",
            baseUrl: brainBaseUrl,
          });
          finish();
        }
        return true;
      }
      return true;
    }

    // ----- preset-pick phase -----
    // The presets, then "your own endpoint" (CUSTOM_ENDPOINT_ID).
    if (foremanLlmPhase === "preset-pick") {
      const ids = [
        ...llmPresetDoc.presets.map((p) => p.id),
        CUSTOM_ENDPOINT_ID,
      ];
      const cursor = presetDraft ?? ids[0] ?? "";
      const idx = Math.max(0, ids.indexOf(cursor));
      if (key.upArrow) {
        setPresetDraft(ids[(idx - 1 + ids.length) % ids.length] ?? null);
        return true;
      }
      if (key.downArrow) {
        setPresetDraft(ids[(idx + 1) % ids.length] ?? null);
        return true;
      }
      if (key.escape) {
        setForemanLlmPhase("picker");
        return true;
      }
      if (key.return || input === " ") {
        const chosen = ids[idx];
        if (chosen === CUSTOM_ENDPOINT_ID) {
          setPresetDraft(chosen);
          setBrainBaseUrlError(null);
          setForemanLlmPhase("custom-url");
        } else if (chosen) {
          setPresetDraft(chosen);
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

    // ----- compat-model phase -----
    // Model for a preset or a custom endpoint. With no list, a preset
    // falls back to its default model on Enter; a custom endpoint asks for
    // the model id in a text input (its onSubmit persists).
    if (foremanLlmPhase === "compat-model") {
      const custom = presetDraft === CUSTOM_ENDPOINT_ID;
      const preset = custom ? null : findPreset(llmPresetDoc, presetDraft ?? "");
      if (key.escape) {
        setCloudModelOptions(null);
        setCloudModelError(null);
        setCloudModelDraft(null);
        setForemanLlmPhase(custom ? "custom-key" : "preset-key");
        if (!custom) setPresetKeyDraft("");
        return true;
      }
      if (cloudModelOptions === null) return true;
      if (cloudModelOptions.length === 0) {
        if (custom) return false;
        if (key.return && preset) {
          persistForemanLlmChoice({
            services,
            choice: "preset",
            ollamaModel: null,
            preset,
            presetKey: presetKeyDraft,
          });
          finish();
        }
        return true;
      }
      const models = orderCompatModels(cloudModelOptions, preset?.default_model);
      const idx = Math.max(
        0,
        models.findIndex((m) => m.id === cloudModelDraft),
      );
      if (key.upArrow) {
        setCloudModelDraft(
          models[(idx - 1 + models.length) % models.length]?.id ?? null,
        );
        return true;
      }
      if (key.downArrow) {
        setCloudModelDraft(models[(idx + 1) % models.length]?.id ?? null);
        return true;
      }
      if (key.return || input === " ") {
        const chosen = models[idx]?.id;
        if (chosen && (preset || (custom && brainBaseUrl))) {
          persistForemanLlmChoice({
            services,
            choice: custom ? "custom" : "preset",
            ollamaModel: null,
            preset,
            presetKey: presetKeyDraft,
            cloudModel: chosen,
            baseUrl: custom ? brainBaseUrl : null,
          });
          finish();
        }
        return true;
      }
      return true;
    }
  }
  return false;
}
