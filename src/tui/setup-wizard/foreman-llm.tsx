import { PasswordInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import type { JSX } from "react";
import { findPreset, type LlmPreset } from "../../core/llm-provider-presets.js";
import { bytesToGb } from "../../core/machine-capability.js";
import { canRunModel } from "../../core/ollama-models.js";
import { planOllamaInstall } from "../../core/ollama-installer.js";
import { WizardProgress } from "../components/wizard-progress.js";
import { theme } from "../theme.js";
import type { WizardContext } from "./context.js";
import {
  formatOllamaRunTag,
  persistForemanLlmChoice,
  type ForemanLlmChoice,
} from "./foreman-llm-logic.js";
import {
  computePickerViewport,
  configuredBrainProviderIds,
} from "./shared.js";

// ---------------- Foreman's brain (#367) ----------------
// Key handling for every phase lives in foreman-llm-input.ts.
export function renderForemanLlmStep(ctx: WizardContext): JSX.Element {
  const {
    services,
    advance,
    providerCatalog,
    machineCap,
    ollamaModelDoc,
    llmPresetDoc,
    ollamaDetection,
  } = ctx;
  const {
    providersSignedIn,
    foremanLlmPhase,
    foremanLlmDraft,
    cloudModelProvider,
    cloudModelOptions,
    cloudModelError,
    cloudModelDraft,
    ollamaModelDraft,
    presetDraft,
  } = ctx.state;
  const { setForemanLlmPhase, setForemanLlmDraft, setPresetKeyDraft } = ctx.set;
  const storedNames = new Set(
    services.secretStore.list().map((s) => s.name),
  );
  // #575 — count API keys AND OAuth subscriptions (ChatGPT → Codex,
  // Claude). A subscription-only user has no key slot but can still run
  // Foreman's brain, so the picker must not grey those rows out.
  const configured = configuredBrainProviderIds(
    providerCatalog,
    storedNames,
    providersSignedIn,
  );

  if (foremanLlmPhase === "picker") {
    // #370 — Universal picker. All cloud rows surface regardless of
    // Step 1 configuration; rows without a configured key render
    // dimmed + are skipped by ↑↓ nav (no-op on Enter with hint).
    // ollama / preset / skip are always available.
    const allRows: {
      value: ForemanLlmChoice;
      label: string;
      sub: string;
      disabled?: boolean;
      disabledReason?: string;
    }[] = [
      // #456 — Drop hardcoded model names from labels. The live model
      // picker (#399) is the source of truth — showing "Claude Haiku"
      // here misleads users who then pick a different model in the
      // next step. Labels show provider + cost hint only.
      {
        value: "anthropic",
        label: "Anthropic",
        sub: "cloud · API key or Claude subscription · model picked next",
        disabled: !configured.has("anthropic"),
        disabledReason:
          "needs an Anthropic key or Claude sign-in in Step 1 — Esc to go back",
      },
      {
        value: "openai",
        label: "OpenAI",
        sub: "cloud · API key or ChatGPT (Codex) subscription · model picked next",
        disabled: !configured.has("openai"),
        disabledReason:
          "needs an OpenAI key or ChatGPT sign-in in Step 1 — Esc to go back",
      },
      {
        value: "gemini",
        label: "Google Gemini",
        sub: "cloud · free tier available · model picked next",
        disabled: !configured.has("gemini"),
        disabledReason: "needs Gemini key in Step 1 — Esc to go back",
      },
      {
        value: "ollama",
        label: "Local — Ollama on this machine",
        sub: ollamaDetection.installed
          ? `free · ${ollamaDetection.installedModels.length} model${
              ollamaDetection.installedModels.length === 1 ? "" : "s"
            } already pulled`
          : "free · install + model wizard",
      },
      {
        value: "preset",
        label: "Custom — OpenAI-compatible",
        sub: "open-source hosts + closed clouds (xAI, Cohere, Mistral, Perplexity)",
      },
      {
        value: "skip",
        label: "Skip — heuristics only",
        sub: "no LLM calls, free, slightly less smart",
      },
    ];
    const enabledRows = allRows.filter((r) => !r.disabled);
    const cursorFromDraft = foremanLlmDraft as ForemanLlmChoice | null;
    const cursorRow =
      (cursorFromDraft && allRows.find((r) => r.value === cursorFromDraft && !r.disabled)) ??
      enabledRows[0] ?? allRows[0];
    const currentCursor: ForemanLlmChoice = cursorRow?.value ?? "skip";
    const focusedDisabledHint = allRows.find(
      (r) => r.value === currentCursor && r.disabled,
    )?.disabledReason;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          current={2}
          total={5}
          label="Foreman's brain"
          phase="pick an LLM"
        />
        <Text color={theme.fg.muted}>
          Foreman uses an LLM to verify risky agent calls and write daily
          summaries. Pick where Foreman should run its own LLM. (Different
          from the per-agent picker in Step 3 — costs below are Foreman's
          own usage, NOT what your agents will spend.)
        </Text>
        <Box flexDirection="column">
          {allRows.map((row) => {
            const selected = row.value === currentCursor;
            const disabledColor = row.disabled ? theme.fg.muted : undefined;
            return (
              <Box key={row.value} flexDirection="row">
                <Text
                  color={
                    selected
                      ? theme.accent.primary
                      : disabledColor
                  }
                  bold={selected && !row.disabled}
                  dimColor={row.disabled}
                >
                  {selected ? "❯ " : "  "}
                  {row.disabled ? "✗ " : "✓ "}
                  {row.label}
                </Text>
                <Text color={theme.fg.muted} dimColor={row.disabled}>
                  {"  "}{row.sub}
                </Text>
              </Box>
            );
          })}
        </Box>
        {focusedDisabledHint ? (
          <Text color={theme.accent.warning}>
            {focusedDisabledHint}
          </Text>
        ) : null}
        <Text color={theme.fg.muted}>
          [↑↓] move · [Enter] or [Space] confirms · [Esc] back to providers
        </Text>
      </Box>
    );
  }

  // #399 — Live model picker. Loading / error / picker tri-state.
  if (foremanLlmPhase === "cloud-model" && cloudModelProvider) {
    const providerLabel =
      cloudModelProvider === "openai"
        ? "OpenAI"
        : cloudModelProvider === "anthropic"
          ? "Anthropic"
          : "Google Gemini";
    if (cloudModelOptions === null) {
      return (
        <Box flexDirection="column" gap={1} paddingY={1}>
          <WizardProgress
            current={2}
            total={5}
            label="Foreman's brain"
            phase={`fetching ${providerLabel} models`}
          />
          <Text color={theme.fg.muted}>
            Talking to {providerLabel}…
          </Text>
          <Text color={theme.fg.muted}>[Esc] cancel</Text>
        </Box>
      );
    }
    if (cloudModelOptions.length === 0) {
      return (
        <Box flexDirection="column" gap={1} paddingY={1}>
          <WizardProgress
            current={2}
            total={5}
            label="Foreman's brain"
            phase={`couldn't list ${providerLabel} models`}
          />
          <Text color={theme.accent.warning}>
            ⚠ {cloudModelError ?? "Unknown error talking to the API."}
          </Text>
          <Text color={theme.fg.muted}>
            [Enter] continue with the default model · [Esc] back to providers
          </Text>
        </Box>
      );
    }
    const cursor = cloudModelDraft ?? cloudModelOptions[0]?.id ?? null;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          current={2}
          total={5}
          label="Foreman's brain"
          phase={`pick a ${providerLabel} model`}
        />
        <Text color={theme.fg.muted}>
          {cloudModelOptions.length} model
          {cloudModelOptions.length === 1 ? "" : "s"} available for this key.
          Pick which one Foreman should use for verification + smart
          summaries.
        </Text>
        {(() => {
          // #448 — Same windowed render the agent model picker uses
          // so the cursor follows past the 12-row viewport instead
          // of moving invisibly through the rest of the list.
          const cursorIdxCm = Math.max(
            0,
            cloudModelOptions.findIndex((m) => m.id === cursor),
          );
          const vpCm = computePickerViewport(
            cloudModelOptions,
            cursorIdxCm,
            12,
          );
          return (
            <Box flexDirection="column">
              {vpCm.topHidden > 0 ? (
                <Text color={theme.fg.muted}>
                  {"    "}↑ {vpCm.topHidden} more above
                </Text>
              ) : null}
              {vpCm.visible.map((row) => {
                const selected = row.id === cursor;
                return (
                  <Box key={row.id} flexDirection="row">
                    <Text
                      color={selected ? theme.accent.primary : undefined}
                      bold={selected}
                    >
                      {selected ? "❯ ✓ " : "    "}
                      {row.label}
                    </Text>
                    {row.label !== row.id ? (
                      <Text color={theme.fg.muted}>{"  "}({row.id})</Text>
                    ) : null}
                  </Box>
                );
              })}
              {vpCm.bottomHidden > 0 ? (
                <Text color={theme.fg.muted}>
                  {"    "}↓ {vpCm.bottomHidden} more below
                </Text>
              ) : null}
            </Box>
          );
        })()}
        <Text color={theme.fg.muted}>
          [↑↓] move · [Enter] or [Space] confirms · [Esc] back to picker
        </Text>
      </Box>
    );
  }

  if (foremanLlmPhase === "ollama-not-installed") {
    const plan = planOllamaInstall(machineCap.os);
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          current={2}
          total={5}
          label="Foreman's brain"
          phase="Ollama not installed"
        />
        <Text color={theme.accent.warning}>
          ⚠ Ollama not detected on this machine.
        </Text>
        {plan.command ? (
          <Box flexDirection="column">
            <Text>To install (run in a separate terminal, then come back):</Text>
            <Text bold color={theme.accent.primary}>
              {"  "}$ {plan.command}
            </Text>
            <Text color={theme.fg.muted}>{plan.description}</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text>
              Windows install is a manual download:{" "}
              <Text color={theme.accent.primary}>{plan.manualUrl}</Text>
            </Text>
            <Text color={theme.fg.muted}>{plan.description}</Text>
          </Box>
        )}
        <Text color={theme.fg.muted}>
          [Enter] re-check · [Esc] back to the picker (pick a different LLM)
        </Text>
      </Box>
    );
  }

  if (foremanLlmPhase === "ollama-model") {
    const usableGb = bytesToGb(
      // usable inference RAM — same heuristic as canRunModel
      Math.max(machineCap.freeRamBytes, machineCap.totalRamBytes - 4 * 1024 ** 3),
    ).toFixed(1);
    const rows = ollamaModelDoc.models.map((model) => ({
      model,
      status: canRunModel(model, machineCap),
    }));
    const enabledRows = rows.filter(
      (r) =>
        r.status.state !== "disabled-ram" &&
        r.status.state !== "disabled-disk",
    );
    const disabledRows = rows.filter(
      (r) =>
        r.status.state === "disabled-ram" ||
        r.status.state === "disabled-disk",
    );
    const cursor =
      ollamaModelDraft ?? enabledRows[0]?.model.name ?? "llama3.2:3b";
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          current={2}
          total={5}
          label="Foreman's brain"
          phase="Ollama ▸ pick a model"
        />
        <Text color={theme.fg.muted}>
          {usableGb} GB usable RAM · {bytesToGb(
            machineCap.freeDiskBytesHome ?? 0,
          ).toFixed(0)} GB free disk · disabled rows can't run on this machine.
        </Text>
        <Box flexDirection="column">
          {enabledRows.map(({ model, status }) => {
            const selected = model.name === cursor;
            const tag = formatOllamaRunTag(model, status, ollamaDetection.installedModels);
            return (
              <Box key={model.name} flexDirection="row">
                <Text
                  color={selected ? theme.accent.primary : undefined}
                  bold={selected}
                >
                  {selected ? "❯ ✓ " : "    "}
                  {model.name.padEnd(20, " ")}
                </Text>
                <Text color={theme.fg.muted}>
                  {model.runtime_ram_gb.toFixed(1).padStart(5, " ")} GB · {model.description}{tag}
                </Text>
              </Box>
            );
          })}
          {disabledRows.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.fg.muted}>
                ────────────────────────────────────────────────────────────
              </Text>
              {disabledRows.map(({ model, status }) => {
                const reason =
                  status.state === "disabled-ram" || status.state === "disabled-disk"
                    ? status.reason
                    : "";
                return (
                  <Box key={model.name} flexDirection="row">
                    <Text color={theme.fg.muted}>{"    "}
                      {model.name.padEnd(20, " ")} {model.runtime_ram_gb.toFixed(0).padStart(4, " ")} GB · ✗ {reason}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          )}
        </Box>
        <Text color={theme.fg.muted}>
          [↑↓] move within enabled rows · [Enter] or [Space] confirms · [Esc] back
        </Text>
      </Box>
    );
  }

  if (foremanLlmPhase === "preset-pick") {
    const cursor = presetDraft ?? llmPresetDoc.presets[0]?.id ?? "deepseek";
    // #370 — Group by category so closed-cloud presets (xAI / Cohere
    // / Mistral / Perplexity) appear under their own divider. Presets
    // without a category fall back to open-source for compat with old
    // registries.
    const openSource = llmPresetDoc.presets.filter(
      (p) => (p.category ?? "open-source") === "open-source",
    );
    const closedCloud = llmPresetDoc.presets.filter(
      (p) => p.category === "closed-cloud",
    );
    const renderRow = (preset: LlmPreset): JSX.Element => {
      const selected = preset.id === cursor;
      return (
        <Box key={preset.id} flexDirection="row">
          <Text
            color={selected ? theme.accent.primary : undefined}
            bold={selected}
          >
            {selected ? "❯ ✓ " : "    "}
            {preset.name.padEnd(24, " ")}
          </Text>
          <Text color={theme.fg.muted}>{preset.cost_hint}</Text>
        </Box>
      );
    };
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          current={2}
          total={5}
          label="Foreman's brain"
          phase="OpenAI-compatible ▸ pick a preset"
        />
        <Text color={theme.fg.muted}>
          All speak the OpenAI /v1/chat/completions shape — pick a preset, paste your API key on the next screen.
        </Text>
        <Box flexDirection="column">
          {openSource.length > 0 ? (
            <>
              <Text color={theme.accent.primary} bold>
                Open-source / multi-model hosts:
              </Text>
              {openSource.map(renderRow)}
            </>
          ) : null}
          {closedCloud.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.accent.primary} bold>
                Closed-source clouds:
              </Text>
              {closedCloud.map(renderRow)}
            </Box>
          ) : null}
        </Box>
        <Text color={theme.fg.muted}>
          [↑↓] move · [Enter] or [Space] confirms · [Esc] back to the picker
        </Text>
      </Box>
    );
  }

  if (foremanLlmPhase === "preset-key") {
    const preset = presetDraft
      ? findPreset(llmPresetDoc, presetDraft)
      : null;
    if (!preset) {
      setForemanLlmPhase("preset-pick");
      return <Text>…</Text>;
    }
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          current={2}
          total={5}
          label="Foreman's brain"
          phase={`${preset.name} ▸ API key`}
        />
        <Text color={theme.fg.muted}>{preset.description}</Text>
        <Text>
          Get your key at{" "}
          <Text color={theme.accent.primary}>{preset.where_to_get}</Text>
        </Text>
        <Text>Paste your {preset.name} API key:</Text>
        <PasswordInput
          key={`foreman-llm-preset:${preset.id}`}
          placeholder="••••••••"
          onChange={(v) => setPresetKeyDraft(v)}
          onSubmit={(v) => {
            const trimmed = (v ?? "").trim();
            if (trimmed.length === 0) return;
            persistForemanLlmChoice({
              services,
              choice: "preset",
              ollamaModel: null,
              preset,
              presetKey: trimmed,
            });
            setForemanLlmPhase("picker");
            setForemanLlmDraft(null);
            setPresetKeyDraft("");
            advance("foreman-llm");
          }}
        />
        <Text color={theme.fg.muted}>
          [Enter] save + continue · [Esc] back to preset picker
        </Text>
      </Box>
    );
  }

  return <Text>…</Text>;
}
