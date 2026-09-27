import { ConfirmInput, MultiSelect } from "@inkjs/ui";
import { Box, Text } from "ink";
import type { JSX } from "react";
import { WizardProgress } from "../components/wizard-progress.js";
import { computeAgentLlmStatuses } from "../setup-wizard-agent-llm-gating.js";
import { theme } from "../theme.js";
import { renderAgentConfigStep } from "./agent-config.js";
import {
  applyAgentsPickerSubmit,
  buildAgentConfigPromptList,
  computeAgentDiff,
} from "./agents-logic.js";
import type { WizardContext } from "./context.js";
import { configuredProviderIds, DEFAULT_AGENTS } from "./shared.js";

// Step 3 — Agents: picker → per-agent config (agent-config.tsx) → confirm.
// Returns null when no agents phase renders (e.g. "running"), so the root
// falls through exactly like the original if-chain.
export function renderAgentsStep(ctx: WizardContext): JSX.Element | null {
  const {
    services,
    advance,
    providerCatalog,
    agentCatalog,
    initialRegistered,
  } = ctx;
  const { agentsSelected, agentsPhase } = ctx.state;
  const {
    setAgentsSelected,
    setAgentsPhase,
    setAgentConfigPrompts,
    setAgentConfigIdx,
    setLlmDraft,
  } = ctx.set;
  // ---------------- Agents — picker ----------------
  if (agentsPhase === "picker") {
    // Compute LLM gating state per agent so labels can surface "needs X key"
    // hints and the post-submit handler can warn on picks that don't have
    // their required LLM configured (#297). configuredProviderIds reflects
    // what's in the vault right now — including keys added earlier in this
    // wizard run via the providers step.
    const pickerStoredNames = new Set(
      services.secretStore.list().map((s) => s.name),
    );
    const pickerConfiguredProviders = configuredProviderIds(
      providerCatalog,
      pickerStoredNames,
    );
    const gatingStatuses = computeAgentLlmStatuses(
      agentCatalog,
      providerCatalog,
      pickerConfiguredProviders,
    );
    // #361 — hide agents whose required LLM isn't configured. Previous UX
    // showed them with a "⚠ needs X key" suffix but kept them togglable;
    // round-3 users could Space-check Claude Code without an Anthropic key
    // and end up with a 401-on-every-call install. We also tried surfacing
    // a "Hidden — add a key in Step 1" notice (#393), but round-3 users
    // kept reading it as "Foreman defaulted to Claude" — silent hiding is
    // the cleanest UX.
    const visibleAgents = agentCatalog.filter(
      (a) => gatingStatuses.get(a.id)?.state !== "needs-llm",
    );
    const options = visibleAgents.map((a) => {
      const installedSuffix = initialRegistered.includes(a.id)
        ? "  (installed)"
        : "";
      return {
        value: a.id,
        label: `${a.name}${installedSuffix} — ${a.tagline}`,
      };
    });
    const compatibleDefaults = (
      initialRegistered.length > 0 ? initialRegistered : DEFAULT_AGENTS
    ).filter((id) => {
      const status = gatingStatuses.get(id);
      return status?.state !== "needs-llm";
    });
    const defaults = compatibleDefaults;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress current={2} total={4} label="Agents" phase="pick which to install" />
        <Text color={theme.fg.muted}>
          ↑↓ move · <Text bold>Space toggle</Text> · Enter confirm. Defaults
          are pre-checked — toggle off any you don't want, toggle on any you
          do. Newly-checked agents are installed; previously-installed agents
          you uncheck are uninstalled.
        </Text>
        {/* #393 — Hidden-agent notice removed entirely. Round-3 user
            kept reading it as \"Foreman is defaulting to Claude\" when
            we meant \"Claude Code is hidden because you can't pick it\".
            Silent hiding is the cleanest UX — the picker only shows
            agents the user CAN actually install. */}
        <Text color={theme.accent.primary}>
          Pre-checked: {defaults.length > 0 ? defaults.join(", ") : "(none)"}
        </Text>
        <MultiSelect
          options={options}
          defaultValue={defaults}
          onSubmit={(values) => {
            const result = applyAgentsPickerSubmit(values);
            setAgentsSelected(result.selected);
            const prompts = buildAgentConfigPromptList(
              agentCatalog,
              result.selected,
              pickerConfiguredProviders,
            );
            setAgentConfigPrompts(prompts);
            setAgentConfigIdx(0);
            setLlmDraft(null);
            // Skip per-agent-config when nothing was picked or every agent is
            // single-provider with no responsibility note to fill — straight
            // to confirm.
            if (prompts.length === 0) {
              setAgentsPhase("confirm");
            } else {
              setAgentsPhase("per-agent-config");
            }
          }}
        />
        <Text color={theme.fg.muted}>
          [Space] toggle · [Enter] confirm · [Esc] back to providers
        </Text>
      </Box>
    );
  }

  if (agentsPhase === "per-agent-config") {
    return renderAgentConfigStep(ctx);
  }

  // ---------------- Agents — confirm ----------------
  // Show the diff before install starts. If the user's selection wasn't what
  // they expected (silent MultiSelect quirk, missed Space toggle), they get
  // one more chance to fix it.
  if (agentsPhase === "confirm") {
    const { toAdd, toRemove } = computeAgentDiff(
      agentsSelected,
      initialRegistered,
    );
    const noChanges = toAdd.length === 0 && toRemove.length === 0;
    const nothingSelected = agentsSelected.length === 0;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress current={2} total={4} label="Agents" phase="confirm" />
        <Text color={theme.fg.muted}>
          Selected:{" "}
          {agentsSelected.length > 0 ? agentsSelected.join(", ") : "(none)"}
        </Text>
        {toAdd.length > 0 && (
          <Text color={theme.accent.primary}>
            ▸ Will install: {toAdd.join(", ")}
          </Text>
        )}
        {toRemove.length > 0 && (
          <Text color={theme.accent.warning}>
            ▸ Will remove: {toRemove.join(", ")}
          </Text>
        )}
        {nothingSelected ? (
          <Box flexDirection="column">
            <Text color={theme.accent.warning} bold>
              ⚠ You must pick at least one agent
            </Text>
            <Text color={theme.fg.muted}>
              Foreman orchestrates AI agents — with none installed there's
              nothing to route, no Telegram replies, no policy enforcement.
              Hit [Esc] to go back and Space-toggle at least one agent.
            </Text>
          </Box>
        ) : noChanges ? (
          <Text color={theme.fg.muted}>
            (no changes — every selection is already registered)
          </Text>
        ) : (
          <Text>Continue to services? (y/n)</Text>
        )}
        <Text color={theme.fg.muted}>
          (n / Esc returns to the selection screen)
        </Text>
        <ConfirmInput
          onConfirm={() => {
            if (nothingSelected) {
              // #audit-finding-2 — Block the advance instead of warn+skip.
              // Previously [y] confirmed past zero-agent state and the user
              // landed on the Done screen with nothing wired.
              setAgentsPhase("picker");
              return;
            }
            setAgentsPhase("running");
            advance("agents");
          }}
          onCancel={() => {
            setAgentsPhase("picker");
          }}
        />
      </Box>
    );
  }
  return null;
}

// Esc back-navigation for the agents step (#153).
export function handleAgentsEscape(ctx: WizardContext): boolean {
  const { currentStep, uncomplete } = ctx;
  const { agentsPhase } = ctx.state;
  const {
    setProvidersPhase,
    setAgentsPhase,
    setAgentConfigIdx,
    setLlmDraft,
  } = ctx.set;
  if (currentStep === "agents") {
    if (agentsPhase === "confirm") {
      setAgentsPhase("picker");
      return true;
    }
    if (agentsPhase === "per-agent-config") {
      setAgentsPhase("picker");
      setAgentConfigIdx(0);
      setLlmDraft(null);
      return true;
    }
    if (agentsPhase === "picker") {
      uncomplete("providers");
      setProvidersPhase("summary");
      return true;
    }
    return true;
  }
  return false;
}
