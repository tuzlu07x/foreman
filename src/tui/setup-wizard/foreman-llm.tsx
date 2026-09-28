import { PasswordInput, TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import type { JSX } from "react";
import { isLoopbackUrl } from "../../core/llm/endpoint.js";
import type { DiscoveredModel } from "../../core/llm/models-discovery.js";
import { findPreset, type LlmPreset } from "../../core/llm-provider-presets.js";
import { bytesToGb } from "../../core/machine-capability.js";
import { planOllamaInstall } from "../../core/ollama-installer.js";
import { WizardProgress } from "../components/wizard-progress.js";
import { theme } from "../theme.js";
import type { WizardContext } from "./context.js";
import { stepProgress } from "./progress.js";
import {
  brainPickerChoices,
  brainPickerCursor,
  CUSTOM_ENDPOINT_ID,
  finishBrainStep,
  initialCustomBaseUrl,
  initialOllamaBaseUrl,
  ollamaModelRows,
  orderCompatModels,
  persistForemanLlmChoice,
  selfHostedTarget,
  startSelfHostedDiscovery,
  validateBrainBaseUrl,
  type ForemanLlmChoice,
} from "./foreman-llm-logic.js";
import {
  computePickerViewport,
  configuredBrainProviderIds,
} from "./shared.js";

// ---------------- Foreman's brain (#367) ----------------
// Key handling for every phase lives in foreman-llm-input.ts; text inputs
// (base URL, API key, custom model id) submit through their onSubmit here.

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
    cloudModelInfo,
    cloudModelDraft,
    ollamaModelDraft,
    presetDraft,
    presetKeyDraft,
    brainBaseUrl,
    brainBaseUrlError,
  } = ctx.state;
  const {
    setForemanLlmPhase,
    setForemanLlmDraft,
    setPresetKeyDraft,
    setBrainBaseUrl,
    setBrainBaseUrlError,
  } = ctx.set;
  const finish = (): void => finishBrainStep(ctx);
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
    // skip, ollama and preset are always available.
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
        label: "Local — Ollama",
        sub: ollamaDetection.installed
          ? `free · ${ollamaDetection.installedModels.length} model${
              ollamaDetection.installedModels.length === 1 ? "" : "s"
            } already pulled · or a remote Ollama URL`
          : "free · this machine or a remote Ollama URL",
      },
      {
        value: "preset",
        label: "Custom — OpenAI-compatible",
        sub: "hosted presets (DeepSeek, Groq, OpenRouter, …) or your own endpoint",
      },
      {
        value: "skip",
        label: "Skip — heuristics only",
        sub: "no LLM calls, free, slightly less smart",
      },
    ];
    // Same cursor resolution as the key handler (foreman-llm-input.ts).
    const currentCursor: ForemanLlmChoice = brainPickerCursor(
      foremanLlmDraft,
      brainPickerChoices(configured),
    );
    const focusedDisabledHint = allRows.find(
      (r) => r.value === currentCursor && r.disabled,
    )?.disabledReason;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          {...stepProgress("foreman-llm")}
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
            {...stepProgress("foreman-llm")}
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
      // No list: either an informational "nothing to list for this
      // sign-in" (#575 follow-up) or a real failure.
      return (
        <Box flexDirection="column" gap={1} paddingY={1}>
          <WizardProgress
            {...stepProgress("foreman-llm")}
            label="Foreman's brain"
            phase={
              cloudModelInfo
                ? `${providerLabel} ▸ default model`
                : `couldn't list ${providerLabel} models`
            }
          />
          {cloudModelInfo ? (
            <Text color={theme.fg.muted}>ⓘ {cloudModelInfo}</Text>
          ) : (
            <Text color={theme.accent.warning}>
              ⚠ {cloudModelError ?? "Unknown error talking to the API."}
            </Text>
          )}
          <Text color={theme.fg.muted}>
            [Enter] continue with the default model · [Esc] back to the picker
          </Text>
        </Box>
      );
    }
    const cursor = cloudModelDraft ?? cloudModelOptions[0]?.id ?? null;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          {...stepProgress("foreman-llm")}
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

  if (foremanLlmPhase === "ollama-url") {
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          {...stepProgress("foreman-llm")}
          label="Foreman's brain"
          phase="Ollama ▸ base URL"
        />
        <Text color={theme.fg.muted}>
          Where is the Ollama server? Keep the default for Ollama on this
          machine, or enter a remote one (http:// or https://). No API key is
          needed.
        </Text>
        <Text>Ollama base URL:</Text>
        <TextInput
          key="foreman-llm-ollama-url"
          defaultValue={initialOllamaBaseUrl(services)}
          onSubmit={(v) => {
            const checked = validateBrainBaseUrl(v ?? "");
            if (!checked.ok) {
              setBrainBaseUrlError(checked.message);
              return;
            }
            setBrainBaseUrlError(null);
            setBrainBaseUrl(checked.url);
            ctx.set.setOllamaModelDraft(null);
            setForemanLlmPhase("ollama-model");
            startSelfHostedDiscovery(
              ctx.set,
              selfHostedTarget("ollama", checked.url, null),
              "",
            );
          }}
        />
        {brainBaseUrlError ? (
          <Text color={theme.accent.warning}>⚠ {brainBaseUrlError}</Text>
        ) : null}
        <Text color={theme.fg.muted}>
          [Enter] list models · [Esc] back to the picker
        </Text>
      </Box>
    );
  }

  if (foremanLlmPhase === "ollama-model" && brainBaseUrl) {
    const local = isLoopbackUrl(brainBaseUrl);
    const header = (
      <WizardProgress
        {...stepProgress("foreman-llm")}
        label="Foreman's brain"
        phase="Ollama ▸ pick a model"
      />
    );
    if (cloudModelOptions === null) {
      return (
        <Box flexDirection="column" gap={1} paddingY={1}>
          {header}
          <Text color={theme.fg.muted}>Talking to Ollama at {brainBaseUrl}…</Text>
          <Text color={theme.fg.muted}>[Esc] back</Text>
        </Box>
      );
    }
    const { selectable, disabled } = ollamaModelRows({
      live: cloudModelOptions,
      catalog: ollamaModelDoc,
      machine: machineCap,
      local,
    });
    const cursor = ollamaModelDraft ?? selectable[0]?.name ?? null;
    const plan = planOllamaInstall(machineCap.os);
    // Nothing answering on this machine and no binary: say how to install.
    const showInstall =
      cloudModelError !== null && local && !ollamaDetection.installed;
    const usableGb = bytesToGb(
      // usable inference RAM — same heuristic as canRunModel
      Math.max(machineCap.freeRamBytes, machineCap.totalRamBytes - 4 * 1024 ** 3),
    ).toFixed(1);
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        {header}
        <Text color={theme.fg.muted}>
          {brainBaseUrl} · {cloudModelOptions.length} model
          {cloudModelOptions.length === 1 ? "" : "s"} pulled
          {local
            ? ` · ${usableGb} GB usable RAM · ${bytesToGb(
                machineCap.freeDiskBytesHome ?? 0,
              ).toFixed(0)} GB free disk`
            : ""}
        </Text>
        {cloudModelError ? (
          <Text color={theme.accent.warning}>⚠ {cloudModelError}</Text>
        ) : null}
        {showInstall ? (
          <Box flexDirection="column">
            <Text color={theme.accent.warning}>
              ⚠ Ollama not detected on this machine.
            </Text>
            {plan.command ? (
              <Text>
                To install (in a separate terminal):{" "}
                <Text bold color={theme.accent.primary}>
                  $ {plan.command}
                </Text>
              </Text>
            ) : (
              <Text>
                Windows install is a manual download:{" "}
                <Text color={theme.accent.primary}>{plan.manualUrl}</Text>
              </Text>
            )}
          </Box>
        ) : null}
        {selectable.length === 0 ? (
          <Text color={theme.fg.muted}>
            No models on this server yet — pull one there (e.g. `ollama pull
            llama3.2:3b`), then press [Enter] to re-check.
          </Text>
        ) : (
          <Box flexDirection="column">
            {selectable.map((row) => {
              const selected = row.name === cursor;
              return (
                <Box key={row.name} flexDirection="row">
                  <Text
                    color={selected ? theme.accent.primary : undefined}
                    bold={selected}
                  >
                    {selected ? "❯ ✓ " : "    "}
                    {row.name.padEnd(20, " ")}
                  </Text>
                  <Text color={theme.fg.muted}>{row.detail}</Text>
                </Box>
              );
            })}
            {disabled.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text color={theme.fg.muted}>
                  ────────────────────────────────────────────────────────────
                </Text>
                {disabled.map((row) => (
                  <Text key={row.name} color={theme.fg.muted}>
                    {"    "}
                    {row.name.padEnd(20, " ")} {row.detail}
                  </Text>
                ))}
              </Box>
            )}
          </Box>
        )}
        {selectable.some((r) => r.name === cursor && !r.pulled) ? (
          <Text color={theme.fg.muted}>
            ⓘ Run `ollama pull {cursor}` before Foreman's brain can use it.
          </Text>
        ) : null}
        <Text color={theme.fg.muted}>
          {selectable.length === 0
            ? "[Enter] re-check · [Esc] change the URL"
            : "[↑↓] move · [Enter] or [Space] confirms · [r] re-check · [Esc] change the URL"}
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
    const customSelected = cursor === CUSTOM_ENDPOINT_ID;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          {...stepProgress("foreman-llm")}
          label="Foreman's brain"
          phase="OpenAI-compatible ▸ pick a preset"
        />
        <Text color={theme.fg.muted}>
          All speak the OpenAI /v1/chat/completions shape — pick a preset and paste your API key, or enter your own endpoint.
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
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.accent.primary} bold>
              Your own server:
            </Text>
            <Box flexDirection="row">
              <Text
                color={customSelected ? theme.accent.primary : undefined}
                bold={customSelected}
              >
                {customSelected ? "❯ ✓ " : "    "}
                {"Other endpoint".padEnd(24, " ")}
              </Text>
              <Text color={theme.fg.muted}>
                vLLM, LM Studio, LiteLLM, … — enter a base URL
              </Text>
            </Box>
          </Box>
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
          {...stepProgress("foreman-llm")}
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
            setPresetKeyDraft(trimmed);
            setForemanLlmPhase("compat-model");
            startSelfHostedDiscovery(
              ctx.set,
              selfHostedTarget("preset", preset.endpoint, preset),
              trimmed,
            );
          }}
        />
        <Text color={theme.fg.muted}>
          [Enter] save + pick a model · [Esc] back to preset picker
        </Text>
      </Box>
    );
  }

  if (foremanLlmPhase === "custom-url") {
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          {...stepProgress("foreman-llm")}
          label="Foreman's brain"
          phase="Own endpoint ▸ base URL"
        />
        <Text color={theme.fg.muted}>
          The OpenAI-compatible base URL, including its version path — e.g.
          http://localhost:8000/v1 for vLLM or http://localhost:1234/v1 for LM
          Studio. Foreman calls {"<base>"}/chat/completions and {"<base>"}/models.
        </Text>
        <Text>Base URL:</Text>
        <TextInput
          key="foreman-llm-custom-url"
          defaultValue={initialCustomBaseUrl(services.secretStore)}
          placeholder="https://host/v1"
          onSubmit={(v) => {
            const checked = validateBrainBaseUrl(v ?? "");
            if (!checked.ok) {
              setBrainBaseUrlError(checked.message);
              return;
            }
            setBrainBaseUrlError(null);
            setBrainBaseUrl(checked.url);
            setForemanLlmPhase("custom-key");
          }}
        />
        {brainBaseUrlError ? (
          <Text color={theme.accent.warning}>⚠ {brainBaseUrlError}</Text>
        ) : null}
        <Text color={theme.fg.muted}>
          [Enter] continue · [Esc] back to the presets
        </Text>
      </Box>
    );
  }

  if (foremanLlmPhase === "custom-key" && brainBaseUrl) {
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          {...stepProgress("foreman-llm")}
          label="Foreman's brain"
          phase="Own endpoint ▸ API key"
        />
        <Text color={theme.fg.muted}>
          {brainBaseUrl} — paste its API key, or leave it empty for a server
          that takes none. The key is stored encrypted and only ever sent to
          this URL.
        </Text>
        <Text>API key (optional):</Text>
        <PasswordInput
          key="foreman-llm-custom-key"
          placeholder="(none)"
          onChange={(v) => setPresetKeyDraft(v)}
          onSubmit={(v) => {
            const trimmed = (v ?? "").trim();
            setPresetKeyDraft(trimmed);
            setForemanLlmPhase("compat-model");
            startSelfHostedDiscovery(
              ctx.set,
              selfHostedTarget("custom", brainBaseUrl, null),
              trimmed,
            );
          }}
        />
        <Text color={theme.fg.muted}>
          [Enter] continue · [Esc] change the URL
        </Text>
      </Box>
    );
  }

  if (foremanLlmPhase === "compat-model") {
    const custom = presetDraft === CUSTOM_ENDPOINT_ID;
    const preset = custom ? null : findPreset(llmPresetDoc, presetDraft ?? "");
    const baseUrl = custom ? brainBaseUrl : (preset?.endpoint ?? null);
    if ((!custom && !preset) || !baseUrl) {
      setForemanLlmPhase("preset-pick");
      return <Text>…</Text>;
    }
    const name = preset?.name ?? "Own endpoint";
    const header = (
      <WizardProgress
        {...stepProgress("foreman-llm")}
        label="Foreman's brain"
        phase={`${name} ▸ pick a model`}
      />
    );
    if (cloudModelOptions === null) {
      return (
        <Box flexDirection="column" gap={1} paddingY={1}>
          {header}
          <Text color={theme.fg.muted}>Talking to {baseUrl}…</Text>
          <Text color={theme.fg.muted}>[Esc] back</Text>
        </Box>
      );
    }
    if (cloudModelOptions.length === 0) {
      return (
        <Box flexDirection="column" gap={1} paddingY={1}>
          {header}
          <Text color={theme.accent.warning}>
            ⚠ {cloudModelError ?? `${baseUrl} listed no models.`}
          </Text>
          {custom ? (
            <Box flexDirection="column">
              <Text>Model id to use:</Text>
              <TextInput
                key="foreman-llm-custom-model"
                placeholder="e.g. meta-llama/Llama-3.1-8B-Instruct"
                onSubmit={(v) => {
                  const model = (v ?? "").trim();
                  if (model.length === 0) return;
                  persistForemanLlmChoice({
                    services,
                    choice: "custom",
                    ollamaModel: null,
                    preset: null,
                    presetKey: presetKeyDraft,
                    cloudModel: model,
                    baseUrl,
                  });
                  finish();
                }}
              />
              <Text color={theme.fg.muted}>
                [Enter] save + continue · [Esc] back
              </Text>
            </Box>
          ) : (
            <Text color={theme.fg.muted}>
              [Enter] continue with {preset?.default_model} · [Esc] back
            </Text>
          )}
        </Box>
      );
    }
    const models: DiscoveredModel[] = orderCompatModels(
      cloudModelOptions,
      preset?.default_model,
    );
    const cursor = cloudModelDraft ?? models[0]?.id ?? null;
    const cursorIdx = Math.max(
      0,
      models.findIndex((m) => m.id === cursor),
    );
    const vp = computePickerViewport(models, cursorIdx, 12);
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        {header}
        <Text color={theme.fg.muted}>
          {models.length} model{models.length === 1 ? "" : "s"} at {baseUrl}.
          Pick which one Foreman should use for verification + smart
          summaries.
        </Text>
        <Box flexDirection="column">
          {vp.topHidden > 0 ? (
            <Text color={theme.fg.muted}>
              {"    "}↑ {vp.topHidden} more above
            </Text>
          ) : null}
          {vp.visible.map((row) => {
            const selected = row.id === cursor;
            return (
              <Text
                key={row.id}
                color={selected ? theme.accent.primary : undefined}
                bold={selected}
              >
                {selected ? "❯ ✓ " : "    "}
                {row.label}
                {row.id === preset?.default_model ? "  (preset default)" : ""}
              </Text>
            );
          })}
          {vp.bottomHidden > 0 ? (
            <Text color={theme.fg.muted}>
              {"    "}↓ {vp.bottomHidden} more below
            </Text>
          ) : null}
        </Box>
        {custom ? null : (
          <Text color={theme.fg.muted}>
            ⓘ Foreman bills this endpoint at its highest known price per token
            so the monthly budget is never under-counted.
          </Text>
        )}
        <Text color={theme.fg.muted}>
          [↑↓] move · [Enter] or [Space] confirms · [Esc] back
        </Text>
      </Box>
    );
  }

  return <Text>…</Text>;
}
