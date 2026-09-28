import type { Key } from "ink";
import {
  applyAgentConfigSubmit,
  applyLlmChoice,
  previousShownAgentPromptIdx,
  variantPickIsShown,
} from "./agents-logic.js";
import type { WizardContext } from "./context.js";

// Esc from variant-pick / model-pick: back to the nearest earlier prompt of
// the same agent that is really shown. Auto-skipped variant prompts are
// stepped over (landing on one bounced straight back, so Esc looped), and
// an agent with no earlier prompt goes back to the agents picker rather
// than the previous agent's responsibility note.
function stepBackFromAgentPrompt(ctx: WizardContext): void {
  const { agentCatalog } = ctx;
  const {
    agentConfigPrompts,
    agentConfigIdx,
    agentConfigs,
    autoPickedVariants,
  } = ctx.state;
  const {
    setAgentsPhase,
    setAgentConfigIdx,
    setAgentVariantDraft,
    setLlmDraft,
  } = ctx.set;
  const target = previousShownAgentPromptIdx(
    agentConfigPrompts,
    agentConfigIdx,
    (p) =>
      p.kind !== "variant-pick" ||
      variantPickIsShown(
        agentCatalog.find((a) => a.id === p.agentId),
        agentConfigs[p.agentId],
        autoPickedVariants[p.agentId],
      ),
  );
  setAgentVariantDraft(null);
  if (target === null) {
    setAgentsPhase("picker");
    setAgentConfigIdx(0);
    setLlmDraft(null);
    return;
  }
  setAgentConfigIdx(target);
}

// #450 — Variant picker handler. Lists variants of the picked
// provider's mapping (e.g. Hermes/openai: via-openrouter vs
// via-codex-oauth). Auto-skip happens in the useEffect when
// single-variant; this handler only runs when multi-variant.
export function handleAgentVariantPickInput(
  ctx: WizardContext,
  input: string,
  key: Key,
): boolean {
  const { currentStep, agentCatalog } = ctx;
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
    setAgentVariantDraft,
  } = ctx.set;
  if (
    currentStep === "agents" &&
    agentsPhase === "per-agent-config"
  ) {
    const prompt = agentConfigPrompts[agentConfigIdx];
    if (prompt && prompt.kind === "variant-pick") {
      const cfg = agentConfigs[prompt.agentId];
      const provider = cfg?.llmProvider;
      const agentEntry = agentCatalog.find((a) => a.id === prompt.agentId);
      const compat = agentEntry?.llm_compat ?? [];
      const effectiveProvider =
        provider ?? (compat.length === 1 ? compat[0] : undefined);
      if (!effectiveProvider || !agentEntry?.provider_mapping) return true;
      const providerMapping = agentEntry.provider_mapping[effectiveProvider];
      if (!providerMapping) return true;
      const variantIds = Object.keys(providerMapping.variants);
      if (variantIds.length <= 1) return true;
      const cursor = agentVariantDraft ?? providerMapping.preferred;
      const idx = Math.max(0, variantIds.indexOf(cursor));
      if (key.upArrow) {
        setAgentVariantDraft(
          variantIds[(idx - 1 + variantIds.length) % variantIds.length] ??
            null,
        );
        return true;
      }
      if (key.downArrow) {
        setAgentVariantDraft(
          variantIds[(idx + 1) % variantIds.length] ?? null,
        );
        return true;
      }
      if (key.escape) {
        // Step back to llm-choice for this agent, or to the agents
        // picker when it has none (single-provider agents).
        stepBackFromAgentPrompt(ctx);
        return true;
      }
      if (key.return || input === " ") {
        const chosen = cursor;
        setAgentConfigs((prev) => ({
          ...prev,
          [prompt.agentId]: {
            ...(prev[prompt.agentId] ?? {}),
            providerVariant: chosen,
          },
        }));
        setAgentVariantDraft(null);
        const result = applyAgentConfigSubmit({
          currentIdx: agentConfigIdx,
          totalPrompts: agentConfigPrompts.length,
        });
        setAgentConfigIdx(result.nextIdx);
        setAgentsPhase(result.nextPhase);
        return true;
      }
      return true;
    }
  }
  return false;
}

// #434 — Per-agent model picker key handling. Shows up between
// llm-choice and responsibility-note. ↑↓ moves cursor through the
// discovered models, Enter commits, [s] skips (uses variant default).
export function handleAgentModelPickInput(
  ctx: WizardContext,
  input: string,
  key: Key,
): boolean {
  const { currentStep } = ctx;
  const {
    agentsPhase,
    agentConfigPrompts,
    agentConfigIdx,
    agentModelOptions,
    agentModelDraft,
  } = ctx.state;
  const {
    setAgentsPhase,
    setAgentConfigIdx,
    setAgentConfigs,
    setAgentModelDraft,
  } = ctx.set;
  if (
    currentStep === "agents" &&
    agentsPhase === "per-agent-config"
  ) {
    const prompt = agentConfigPrompts[agentConfigIdx];
    if (prompt && prompt.kind === "model-pick") {
      // Loading: only Esc/s actionable.
      if (agentModelOptions === null) {
        if (key.escape) {
          stepBackFromAgentPrompt(ctx);
          return true;
        }
        if (input === "s" || input === "S") {
          // Skip → advance without storing modelVersion (= variant default).
          const result = applyAgentConfigSubmit({
            currentIdx: agentConfigIdx,
            totalPrompts: agentConfigPrompts.length,
          });
          setAgentConfigIdx(result.nextIdx);
          setAgentsPhase(result.nextPhase);
          return true;
        }
        return true;
      }
      // Error / empty list: only [s]kip or [Enter] (accepted as skip)
      // advances. Esc goes back to the provider choice for the same agent:
      // its variant prompt when that is really shown, else its llm-choice,
      // else the agents picker (see stepBackFromAgentPrompt).
      if (agentModelOptions.length === 0) {
        if (key.escape) {
          stepBackFromAgentPrompt(ctx);
          return true;
        }
        if (key.return || input === "s" || input === "S") {
          const result = applyAgentConfigSubmit({
            currentIdx: agentConfigIdx,
            totalPrompts: agentConfigPrompts.length,
          });
          setAgentConfigIdx(result.nextIdx);
          setAgentsPhase(result.nextPhase);
          return true;
        }
        return true;
      }
      // Picker active.
      const cursor = agentModelDraft ?? agentModelOptions[0]?.id ?? null;
      const idx = agentModelOptions.findIndex((m) => m.id === cursor);
      const safeIdx = idx < 0 ? 0 : idx;
      if (key.upArrow) {
        const len = agentModelOptions.length;
        setAgentModelDraft(
          agentModelOptions[(safeIdx - 1 + len) % len]?.id ?? null,
        );
        return true;
      }
      if (key.downArrow) {
        const len = agentModelOptions.length;
        setAgentModelDraft(agentModelOptions[(safeIdx + 1) % len]?.id ?? null);
        return true;
      }
      if (key.escape) {
        stepBackFromAgentPrompt(ctx);
        return true;
      }
      if (input === "s" || input === "S") {
        // Skip → no modelVersion stored; variant default applies.
        const result = applyAgentConfigSubmit({
          currentIdx: agentConfigIdx,
          totalPrompts: agentConfigPrompts.length,
        });
        setAgentConfigIdx(result.nextIdx);
        setAgentsPhase(result.nextPhase);
        return true;
      }
      if (key.return || input === " ") {
        if (cursor) {
          setAgentConfigs((prev) => {
            const existing = prev[prompt.agentId] ?? {};
            return {
              ...prev,
              [prompt.agentId]: { ...existing, modelVersion: cursor },
            };
          });
        }
        const result = applyAgentConfigSubmit({
          currentIdx: agentConfigIdx,
          totalPrompts: agentConfigPrompts.length,
        });
        setAgentConfigIdx(result.nextIdx);
        setAgentsPhase(result.nextPhase);
        return true;
      }
    }
  }
  return false;
}

// #358 — Per-agent LLM picker key handling. ↑↓ live-updates the
// selection (cursor + ✓ travel together — round-3 muscle memory
// expectation), Space or Enter commits and advances. The render side
// pulls from llmDraft so updating it re-renders the radio in place.
export function handleAgentLlmChoiceInput(
  ctx: WizardContext,
  input: string,
  key: Key,
): boolean {
  const { currentStep, llmPickerOptions } = ctx;
  const {
    agentsPhase,
    agentConfigPrompts,
    agentConfigIdx,
    agentConfigs,
    llmDraft,
  } = ctx.state;
  const {
    setAgentsPhase,
    setAgentConfigIdx,
    setAgentConfigs,
    setAutoPickedVariants,
    setLlmDraft,
  } = ctx.set;
  if (
    currentStep === "agents" &&
    agentsPhase === "per-agent-config" &&
    llmPickerOptions.length > 0
  ) {
    const prompt = agentConfigPrompts[agentConfigIdx];
    if (prompt && prompt.kind === "llm-choice") {
      const currentChoice = llmDraft ?? llmPickerOptions[0];
      const currentIdx = Math.max(
        0,
        llmPickerOptions.indexOf(currentChoice ?? ""),
      );
      if (key.upArrow) {
        const nextIdx =
          (currentIdx - 1 + llmPickerOptions.length) %
          llmPickerOptions.length;
        setLlmDraft(llmPickerOptions[nextIdx] ?? null);
        return true;
      }
      if (key.downArrow) {
        const nextIdx = (currentIdx + 1) % llmPickerOptions.length;
        setLlmDraft(llmPickerOptions[nextIdx] ?? null);
        return true;
      }
      if (key.return || input === " ") {
        const chosen = llmDraft ?? llmPickerOptions[0];
        if (chosen) {
          setAgentConfigs((prev) => ({
            ...prev,
            [prompt.agentId]: applyLlmChoice(prev[prompt.agentId] ?? {}, chosen),
          }));
          if (agentConfigs[prompt.agentId]?.llmProvider !== chosen) {
            // The auto-picked route belonged to the old provider.
            setAutoPickedVariants((prev) => {
              if (!(prompt.agentId in prev)) return prev;
              const next = { ...prev };
              delete next[prompt.agentId];
              return next;
            });
          }
        }
        const result = applyAgentConfigSubmit({
          currentIdx: agentConfigIdx,
          totalPrompts: agentConfigPrompts.length,
        });
        setAgentConfigIdx(result.nextIdx);
        setAgentsPhase(result.nextPhase);
        setLlmDraft(null);
        return true;
      }
    }
  }
  return false;
}

// Claude Code's PreToolUse hook: y / Enter keeps the default (install it),
// n leaves it out. Other keys fall through (Esc goes back to selection).
export function handleAgentHookChoiceInput(
  ctx: WizardContext,
  input: string,
  key: Key,
): boolean {
  const { currentStep } = ctx;
  const { agentsPhase, agentConfigPrompts, agentConfigIdx } = ctx.state;
  const { setAgentsPhase, setAgentConfigIdx, setAgentConfigs } = ctx.set;
  if (currentStep !== "agents" || agentsPhase !== "per-agent-config") return false;
  const prompt = agentConfigPrompts[agentConfigIdx];
  if (!prompt || prompt.kind !== "hook-choice") return false;
  let choice: boolean | null = null;
  if (key.return || input === "y" || input === "Y") choice = true;
  else if (input === "n" || input === "N") choice = false;
  if (choice === null) return false;
  const preToolUseHook = choice;
  setAgentConfigs((prev) => ({
    ...prev,
    [prompt.agentId]: { ...(prev[prompt.agentId] ?? {}), preToolUseHook },
  }));
  const result = applyAgentConfigSubmit({
    currentIdx: agentConfigIdx,
    totalPrompts: agentConfigPrompts.length,
  });
  setAgentConfigIdx(result.nextIdx);
  setAgentsPhase(result.nextPhase);
  return true;
}
