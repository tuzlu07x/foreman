import { TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import type { JSX } from "react";
import { WizardProgress } from "../components/wizard-progress.js";
import { theme } from "../theme.js";
import {
  applyAgentConfigSubmit,
  findSiblingCredHint,
} from "./agents-logic.js";
import type { WizardContext } from "./context.js";
import { computePickerViewport } from "./shared.js";

// ---------------- Agents — per-agent config ----------------
// One screen per AgentConfigPrompt: llm-choice → variant-pick →
// model-pick → responsibility-note. Key handling lives in
// agent-config-input.ts; auto-skip + discovery effects in
// agent-config-hooks.ts.
export function renderAgentConfigStep(ctx: WizardContext): JSX.Element {
  const { services, providerCatalog, agentCatalog, llmPickerOptions } = ctx;
  const {
    agentConfigPrompts,
    agentConfigIdx,
    agentConfigs,
    llmDraft,
    agentModelOptions,
    agentModelError,
    agentModelDraft,
    agentVariantDraft,
  } = ctx.state;
  const {
    setAgentsPhase,
    setAgentConfigIdx,
    setAgentConfigs,
    setLlmDraft,
  } = ctx.set;
  const prompt = agentConfigPrompts[agentConfigIdx];
  if (!prompt) {
    setAgentsPhase("confirm");
    return <Text>…</Text>;
  }
  const agent = agentCatalog.find((a) => a.id === prompt.agentId);
  if (!agent) {
    setAgentsPhase("confirm");
    return <Text>…</Text>;
  }
  const progress = `(${agentConfigIdx + 1}/${agentConfigPrompts.length})`;
  if (prompt.kind === "llm-choice") {
    // llmPickerOptions (component-scoped useMemo) is the single source of
    // truth for both render and the ↑↓/Space/Enter handler in useInput.
    // #297 filters compat to configured providers; #348 sorts by user
    // preference order from Step 1; #358 lets render + input share state.
    const compat = agent.llm_compat ?? [];
    const orderedAvailable = llmPickerOptions;
    const options = orderedAvailable.map((id) => {
      const provider = providerCatalog.find((p) => p.id === id);
      return {
        value: id,
        label: provider ? provider.name : id,
      };
    });
    const defaultChoice = orderedAvailable[0] ?? compat[0];
    const currentChoice = llmDraft ?? defaultChoice;
    const currentProvider = providerCatalog.find((p) => p.id === currentChoice);
    const currentLabel = currentProvider?.name ?? currentChoice;
    // #358 — Custom radio render so the cursor (❯) and the selection (✓)
    // travel together as one indicator. Round-3 users with @inkjs/ui's
    // Select kept pressing Space expecting the ✓ to follow the cursor, and
    // the "Space does nothing" footer hint never caught up with muscle
    // memory. The ↑↓ / Space / Enter handlers live in
    // handleAgentLlmChoiceInput (agent-config-input.ts).
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          current={2}
          total={4}
          label="Agents"
          phase={`${agent.name} ${progress}`}
        />
        <Text color={theme.fg.muted}>
          {options.length > 1
            ? `Pick the LLM provider ${agent.name} should use. Only providers you configured in Step 1 are shown.`
            : `${agent.name} supports ${compat.length} providers, but only ${currentLabel} is configured. Press [Enter] to confirm.`}
        </Text>
        <Text>
          Currently selected:{" "}
          <Text bold color={theme.accent.primary}>
            {currentLabel}
          </Text>
        </Text>
        <Box flexDirection="column">
          {options.map((opt) => {
            const isSelected = opt.value === currentChoice;
            return (
              <Text
                key={opt.value}
                color={isSelected ? theme.accent.primary : undefined}
                bold={isSelected}
              >
                {isSelected ? "❯ ✓ " : "    "}
                {opt.label}
              </Text>
            );
          })}
        </Box>
        <Text color={theme.fg.muted}>
          {options.length > 1
            ? "[↑↓] move · [Enter] or [Space] confirms · [Esc] goes back."
            : "[Enter] confirms · [Esc] goes back. Add another provider in Step 1 if you want to switch later."}
        </Text>
      </Box>
    );
  }
  // #450 — Variant pick phase. Shows when the picked provider's
  // mapping has multiple variants (e.g. Hermes/openai: OpenRouter
  // route vs Codex OAuth route). Auto-skips otherwise via useEffect.
  if (prompt.kind === "variant-pick") {
    const cfg = agentConfigs[prompt.agentId];
    const compat = agent.llm_compat ?? [];
    const effectiveProvider =
      cfg?.llmProvider ?? (compat.length === 1 ? compat[0] : undefined);
    const providerMapping =
      effectiveProvider && agent.provider_mapping
        ? agent.provider_mapping[effectiveProvider]
        : undefined;
    const variantIds = providerMapping
      ? Object.keys(providerMapping.variants)
      : [];
    const cursor = agentVariantDraft ?? providerMapping?.preferred ?? variantIds[0];
    const providerLabel =
      effectiveProvider === "openai"
        ? "OpenAI"
        : effectiveProvider === "anthropic"
          ? "Anthropic"
          : effectiveProvider === "gemini"
            ? "Google Gemini"
            : effectiveProvider ?? "(unknown)";
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          current={2}
          total={4}
          label="Agents"
          phase={`${agent.name} ${progress} · how to reach ${providerLabel}`}
        />
        <Text color={theme.fg.muted}>
          {agent.name} can reach {providerLabel} more than one way. Pick the
          route that matches the credentials you already have — Foreman will
          ask only for the secret that route needs.
        </Text>
        <Box flexDirection="column">
          {variantIds.map((vid) => {
            const v = providerMapping!.variants[vid]!;
            const isSelected = vid === cursor;
            // #461 — Variants that piggyback on another agent's OAuth
            // must say so. Showing "no extra key needed" used to send
            // users straight into a silent provider-auth failure.
            const reqHint = v.required_secret
              ? `needs ${v.required_secret}`
              : v.depends_on_oauth
                ? `requires ${v.depends_on_oauth.agent} OAuth (run \`${v.depends_on_oauth.setup_command}\` first)`
                : "no extra key needed";
            const acq = v.secret_acquisition?.note;
            // #469 — Cross-variant credential check. When the
            // highlighted variant needs OAuth / no key, but the user
            // already pasted a key that a SIBLING variant uses, flash
            // a note so they understand which route their key actually
            // wires up. Prevents the "I pasted my OpenAI key, why is
            // Hermes still failing?" rabbit hole.
            const storedSecrets = new Set(
              services.secretStore.list().map((s) => s.name),
            );
            const siblingHint =
              isSelected && !v.required_secret
                ? findSiblingCredHint(
                    providerMapping!,
                    vid,
                    storedSecrets,
                  )
                : null;
            return (
              <Box flexDirection="column" key={vid}>
                <Text
                  color={isSelected ? theme.accent.primary : undefined}
                  bold={isSelected}
                >
                  {isSelected ? "❯ ✓ " : "    "}
                  {v.label}
                </Text>
                <Text color={theme.fg.muted}>
                  {"      "}
                  {reqHint}
                  {vid === providerMapping!.preferred
                    ? "  · default"
                    : ""}
                </Text>
                {isSelected && acq ? (
                  <Text color={theme.fg.muted}>
                    {"      "}
                    {acq.slice(0, 220)}
                  </Text>
                ) : null}
                {siblingHint ? (
                  <Text color={theme.accent.warning}>
                    {"      ⓘ "}
                    {siblingHint}
                  </Text>
                ) : null}
                {/* QA round 6: when the highlighted variant uses
                    OAuth (no key) and is NOT a Step-1-key route, hint
                    that this auth lives inside the agent itself —
                    Foreman's stored keys won't satisfy it. */}
                {isSelected && !v.required_secret && v.interactive_setup ? (
                  <Text color={theme.fg.muted}>
                    {"      ⓘ This route runs the agent's OWN OAuth flow — Foreman's stored API keys do NOT apply. Foreman auto-spawns `"}
                    {v.interactive_setup}
                    {"` on the Done screen."}
                  </Text>
                ) : null}
              </Box>
            );
          })}
        </Box>
        <Text color={theme.fg.muted}>
          [↑↓] move · [Enter] confirm · [Esc] back to provider choice
        </Text>
      </Box>
    );
  }
  // #434 — Model-pick phase. Loading / error / picker tri-state, mirrors
  // the foreman-llm cloud-model phase (#399).
  if (prompt.kind === "model-pick") {
    const provider = agentConfigs[prompt.agentId]?.llmProvider ?? "";
    const providerLabel =
      provider === "openai"
        ? "OpenAI"
        : provider === "anthropic"
          ? "Anthropic"
          : provider === "gemini"
            ? "Google Gemini"
            : provider;
    if (agentModelOptions === null) {
      return (
        <Box flexDirection="column" gap={1} paddingY={1}>
          <WizardProgress
            current={2}
            total={4}
            label="Agents"
            phase={`${agent.name} ${progress} · fetching ${providerLabel} models`}
          />
          <Text color={theme.fg.muted}>Talking to {providerLabel}…</Text>
          <Text color={theme.fg.muted}>
            [s] skip (use the registry default) · [Esc] back
          </Text>
        </Box>
      );
    }
    if (agentModelOptions.length === 0) {
      return (
        <Box flexDirection="column" gap={1} paddingY={1}>
          <WizardProgress
            current={2}
            total={4}
            label="Agents"
            phase={`${agent.name} ${progress} · model discovery failed`}
          />
          <Text color={theme.accent.warning}>
            ⚠ {agentModelError ?? `Could not fetch ${providerLabel} models.`}
          </Text>
          <Text color={theme.fg.muted}>
            [Enter] / [s] skip to use the registry default · [Esc] go back
          </Text>
        </Box>
      );
    }
    const cursor = agentModelDraft ?? agentModelOptions[0]?.id ?? null;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          current={2}
          total={4}
          label="Agents"
          phase={`${agent.name} ${progress} · pick a ${providerLabel} model`}
        />
        <Text color={theme.fg.muted}>
          Which {providerLabel} model should {agent.name} use? Skipping
          keeps the registry default.
        </Text>
        {(() => {
          // #448 — Windowed render so the cursor stays visible past
          // row 12. Without this, ↑↓ moves through the full list but
          // only the first 12 ever render.
          const cursorIdx = Math.max(
            0,
            agentModelOptions.findIndex((m) => m.id === cursor),
          );
          const vp = computePickerViewport(
            agentModelOptions,
            cursorIdx,
            12,
          );
          return (
            <Box flexDirection="column">
              {vp.topHidden > 0 ? (
                <Text color={theme.fg.muted}>
                  {"    "}↑ {vp.topHidden} more above
                </Text>
              ) : null}
              {vp.visible.map((model) => {
                const isSelected = model.id === cursor;
                return (
                  <Text
                    key={model.id}
                    color={isSelected ? theme.accent.primary : undefined}
                    bold={isSelected}
                  >
                    {isSelected ? "❯ ✓ " : "    "}
                    {model.id}
                  </Text>
                );
              })}
              {vp.bottomHidden > 0 ? (
                <Text color={theme.fg.muted}>
                  {"    "}↓ {vp.bottomHidden} more below
                </Text>
              ) : null}
            </Box>
          );
        })()}
        <Text color={theme.fg.muted}>
          [↑↓] move · [Enter] confirm · [s] skip · [Esc] back
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" gap={1} paddingY={1}>
      <WizardProgress
        current={2}
        total={4}
        label="Agents"
        phase={`${agent.name} — responsibility note ${progress}`}
      />
      <Text color={theme.fg.muted}>
        Short description of what this agent is for. Surfaces in the audit
        log, approval modal, and dashboard. Optional — Enter on empty input
        to skip.
      </Text>
      <Text color={theme.fg.muted}>
        Examples: "Code review", "Daily personal assistant on Telegram",
        "Refactor suggestions"
      </Text>
      <TextInput
        // Remount per agent prompt so the previous agent's note doesn't bleed in (#219).
        key={`agent-note:${prompt.agentId}`}
        placeholder=""
        onSubmit={(value) => {
          setAgentConfigs((prev) => {
            const existing = prev[prompt.agentId] ?? {};
            return {
              ...prev,
              [prompt.agentId]: {
                ...existing,
                responsibilityNote: value.length > 0 ? value : undefined,
              },
            };
          });
          const result = applyAgentConfigSubmit({
            currentIdx: agentConfigIdx,
            totalPrompts: agentConfigPrompts.length,
          });
          setAgentConfigIdx(result.nextIdx);
          setAgentsPhase(result.nextPhase);
          setLlmDraft(null);
        }}
      />
      <Text color={theme.fg.muted}>
        [Enter] save · [Esc] back to selection
      </Text>
    </Box>
  );
}
