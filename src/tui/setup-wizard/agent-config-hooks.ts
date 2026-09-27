import { useEffect, useMemo } from "react";
import {
  discoverModels,
  ModelDiscoveryError,
} from "../../core/llm/models-discovery.js";
import {
  applyAgentConfigSubmit,
  classifyModelDiscoveryError,
  computeSingleCompatProviderSeeds,
} from "./agents-logic.js";
import type { WizardContext } from "./context.js";
import { configuredProviderIds } from "./shared.js";
import type { WizardState } from "./state.js";

// #358 — Computed once per relevant state change so both render and the
// useInput handler operate on the same ordered list. Empty array when
// we're not in the llm-choice phase, so callers can early-return.
export function useLlmPickerOptions(
  args: Pick<
    WizardContext,
    "agentCatalog" | "providerCatalog" | "services"
  > &
    Pick<
      WizardState,
      "agentsPhase" | "agentConfigPrompts" | "agentConfigIdx" | "providersSaved"
    >,
): string[] {
  const {
    agentsPhase,
    agentConfigPrompts,
    agentConfigIdx,
    agentCatalog,
    providerCatalog,
    providersSaved,
    services,
  } = args;
  return useMemo<string[]>(() => {
    if (agentsPhase !== "per-agent-config") return [];
    const prompt = agentConfigPrompts[agentConfigIdx];
    if (!prompt || prompt.kind !== "llm-choice") return [];
    const agent = agentCatalog.find((a) => a.id === prompt.agentId);
    if (!agent) return [];
    const compat = agent.llm_compat ?? [];
    const storedNames = new Set(
      services.secretStore.list().map((s) => s.name),
    );
    const configured = new Set(
      configuredProviderIds(providerCatalog, storedNames),
    );
    const available = compat.filter((id) => configured.has(id));
    const prefOrder = providersSaved
      .map((name) => providerCatalog.find((p) => p.secret_name === name)?.id)
      .filter((id): id is string => typeof id === "string");
    return [...available].sort((a, b) => {
      const aIdx = prefOrder.indexOf(a);
      const bIdx = prefOrder.indexOf(b);
      if (aIdx === -1 && bIdx === -1) return 0;
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });
  }, [
    agentsPhase,
    agentConfigPrompts,
    agentConfigIdx,
    agentCatalog,
    providerCatalog,
    providersSaved,
    services.secretStore,
  ]);
}

// Per-agent-config side effects, in their original order: single-compat
// provider seeding (#471), variant auto-skip (#450/#457) and live model
// discovery (#434).
export function useAgentConfigEffects(ctx: WizardContext): void {
  const { services, currentStep, agentCatalog } = ctx;
  const {
    agentsPhase,
    agentConfigPrompts,
    agentConfigIdx,
    agentConfigs,
    agentVariantDraft,
  } = ctx.state;
  const {
    setAgentsPhase,
    setAgentConfigIdx,
    setAgentConfigs,
    setAgentModelOptions,
    setAgentModelError,
    setAgentModelDraft,
    setAgentVariantDraft,
    setAutoPickedVariants,
  } = ctx.set;
  // #471 — Single-compat agents (Codex/openai-only, Claude Code/anthropic-only)
  // never show the llm-choice picker (#355 only fires it for compat.length > 1),
  // and the variant-pick auto-skip used compat[0] LOCALLY without persisting.
  // Result: agent registered with llm_provider:null → resolver skips it
  // → identity push fails → "1 of 2 agents pushed" + broken downstream auth.
  // Seed llmProvider here, BEFORE any picker phase reads it, so every agent
  // in the per-agent-config flow has a provider stamped from the start.
  useEffect(() => {
    if (currentStep !== "agents") return;
    if (agentsPhase !== "per-agent-config") return;
    const updates = computeSingleCompatProviderSeeds(
      agentConfigPrompts,
      agentConfigs,
      agentCatalog,
    );
    if (Object.keys(updates).length === 0) return;
    setAgentConfigs((prev) => {
      const next = { ...prev };
      for (const [id, llmProvider] of Object.entries(updates)) {
        next[id] = { ...(next[id] ?? {}), llmProvider };
      }
      return next;
    });
  }, [
    currentStep,
    agentsPhase,
    agentConfigPrompts,
    agentConfigs,
    agentCatalog,
  ]);

  // #450 — Whenever we land on a variant-pick prompt, auto-skip when
  // the picked provider's mapping has only one variant. Also seeds
  // the picker cursor to the registry's `preferred` so the user can
  // Enter to accept the default.
  useEffect(() => {
    if (currentStep !== "agents") return;
    if (agentsPhase !== "per-agent-config") return;
    const prompt = agentConfigPrompts[agentConfigIdx];
    if (!prompt || prompt.kind !== "variant-pick") return;
    const cfg = agentConfigs[prompt.agentId];
    const provider = cfg?.llmProvider;
    const agentEntry = agentCatalog.find((a) => a.id === prompt.agentId);
    // Resolve effective provider: user pick first, else compat[0] for
    // single-provider agents.
    const compat = agentEntry?.llm_compat ?? [];
    const effectiveProvider =
      provider ?? (compat.length === 1 ? compat[0] : undefined);
    if (!effectiveProvider || !agentEntry?.provider_mapping) {
      const next = applyAgentConfigSubmit({
        currentIdx: agentConfigIdx,
        totalPrompts: agentConfigPrompts.length,
      });
      setAgentConfigIdx(next.nextIdx);
      setAgentsPhase(next.nextPhase);
      return;
    }
    const providerMapping = agentEntry.provider_mapping[effectiveProvider];
    const variants = providerMapping ? Object.keys(providerMapping.variants) : [];
    if (variants.length <= 1) {
      // Single variant → no choice to make; auto-pick + advance.
      if (variants.length === 1 && !cfg?.providerVariant) {
        setAgentConfigs((prev) => ({
          ...prev,
          [prompt.agentId]: { ...(prev[prompt.agentId] ?? {}), providerVariant: variants[0]! },
        }));
      }
      const next = applyAgentConfigSubmit({
        currentIdx: agentConfigIdx,
        totalPrompts: agentConfigPrompts.length,
      });
      setAgentConfigIdx(next.nextIdx);
      setAgentsPhase(next.nextPhase);
      return;
    }
    // #457 — Multi-variant case but the preferred route is no-credential
    // (e.g. Codex/oauth). Skip the picker so the user doesn't have to
    // confirm the obvious; the required-setup screen flashes a
    // "Foreman picked: <label>" notice so they know what happened.
    if (providerMapping && !cfg?.providerVariant) {
      const preferredId = providerMapping.preferred;
      const preferredVariant = providerMapping.variants[preferredId];
      if (preferredVariant && !preferredVariant.required_secret) {
        setAgentConfigs((prev) => ({
          ...prev,
          [prompt.agentId]: {
            ...(prev[prompt.agentId] ?? {}),
            providerVariant: preferredId,
          },
        }));
        setAutoPickedVariants((prev) => ({
          ...prev,
          [prompt.agentId]: {
            variantId: preferredId,
            label: preferredVariant.label,
          },
        }));
        const next = applyAgentConfigSubmit({
          currentIdx: agentConfigIdx,
          totalPrompts: agentConfigPrompts.length,
        });
        setAgentConfigIdx(next.nextIdx);
        setAgentsPhase(next.nextPhase);
        return;
      }
    }
    // Seed the cursor to preferred variant.
    if (!agentVariantDraft && providerMapping) {
      setAgentVariantDraft(providerMapping.preferred);
    }
  }, [
    currentStep,
    agentsPhase,
    agentConfigIdx,
    agentConfigPrompts,
    agentConfigs,
    agentCatalog,
    agentVariantDraft,
  ]);

  // #434 — Whenever we land on a model-pick prompt, kick off model
  // discovery for the active agent's picked provider. Stale state
  // (from a previous prompt) is wiped so the user sees "loading"
  // instead of last agent's list.
  useEffect(() => {
    if (currentStep !== "agents") return;
    if (agentsPhase !== "per-agent-config") return;
    const prompt = agentConfigPrompts[agentConfigIdx];
    if (!prompt || prompt.kind !== "model-pick") return;
    // #434 — Provider resolution priority:
    //   1. The user's per-agent llm-choice if it ran.
    //   2. The sole compat entry for single-provider agents (no
    //      llm-choice would have been shown).
    //   3. None → auto-skip below.
    const userPicked = agentConfigs[prompt.agentId]?.llmProvider;
    const agentEntry = agentCatalog.find((a) => a.id === prompt.agentId);
    const compat = agentEntry?.llm_compat ?? [];
    const provider = userPicked ?? (compat.length === 1 ? compat[0] : undefined);
    if (!provider || (provider !== "openai" && provider !== "anthropic" && provider !== "gemini")) {
      // Skip discovery for providers without a live /v1/models endpoint
      // (Ollama, openai_compatible). The user can't pick a version
      // through this UI; auto-advance to responsibility-note.
      const result = applyAgentConfigSubmit({
        currentIdx: agentConfigIdx,
        totalPrompts: agentConfigPrompts.length,
      });
      setAgentConfigIdx(result.nextIdx);
      setAgentsPhase(result.nextPhase);
      return;
    }
    setAgentModelOptions(null);
    setAgentModelError(null);
    setAgentModelDraft(null);
    void (async (): Promise<void> => {
      const keySecret = `${provider}-key`;
      try {
        const apiKey = services.secretStore.exists(keySecret)
          ? services.secretStore.get(keySecret)
          : null;
        if (!apiKey) {
          setAgentModelError(
            `No ${provider}-key in the secret store — skip to use the registry default.`,
          );
          setAgentModelOptions([]);
          return;
        }
        const models = await discoverModels(provider, { apiKey });
        if (models.length === 0) {
          setAgentModelError(
            `${provider} returned no chat-capable models — skip to use the registry default.`,
          );
        }
        setAgentModelOptions(models);
      } catch (err) {
        const rawMsg =
          err instanceof ModelDiscoveryError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        // #audit-finding-6 — Translate raw HTTP errors into actionable
        // hints. The bare "HTTP 401 from …" was leaving users guessing
        // whether to fix their key, switch providers, or wait.
        setAgentModelError(classifyModelDiscoveryError(rawMsg, provider));
        setAgentModelOptions([]);
      }
    })();
  }, [
    currentStep,
    agentsPhase,
    agentConfigIdx,
    agentConfigPrompts,
    agentConfigs,
    services.secretStore,
  ]);
}
