import { existsSync, readFileSync } from "node:fs";
import { Box, Text, useApp, useInput } from "ink";
import { parse as parseYaml } from "yaml";
import {
  ConfirmInput,
  MultiSelect,
  PasswordInput,
  Select,
  StatusMessage,
  TextInput,
} from "@inkjs/ui";
import { useEffect, useMemo, useState } from "react";
import {
  checkSecrets,
  pickConfigPath,
  registerAgent,
} from "../core/agent-add-flow.js";
import {
  applyInjection,
  planInjection,
  UnsupportedConfigFormatError,
} from "../core/agent-config-injector.js";
import {
  detectInstall,
  preferredUninstallCommand,
  runInstall,
  runUninstall,
} from "../core/agent-install.js";
import { buildMcpSnippet } from "../core/agent-mcp-snippet.js";
import {
  findAgent,
  loadActiveProviders,
  loadActiveRegistry,
  loadActiveServices,
  type AgentEntry,
  type ProviderEntry,
} from "../core/registry-catalog.js";
import { runDoctor, type DoctorReport } from "../core/doctor.js";
import { applyForemanSoul } from "../core/foreman-soul.js";
import { RegistryService } from "../core/registry.js";
import { SecretStore } from "../core/secret-store.js";
import type { ForemanDb } from "../db/client.js";
import { getForemanPaths } from "../utils/config.js";
import {
  markCompleted,
  markUncompleted,
  saveSetupState,
  type SetupState,
  type Step,
} from "./setup-state.js";
import { theme } from "./theme.js";

const DEFAULT_AGENTS = ["hermes", "claude-code"];

export interface WizardServices {
  db: ForemanDb;
  secretStore: SecretStore;
  registry: RegistryService;
  policyPath: string;
  launchEditor: (path: string) => Promise<unknown>;
}

export interface SetupWizardProps {
  initialState: SetupState;
  services: WizardServices;
}

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

// Same phase-machine pattern as Secrets — the old `agentsDone` boolean made
// the picker drop straight into install with no confirmation step, so a
// silently-defaulted selection couldn't be caught before it ran (#152).
// `per-agent-config` is the sub-step inserted between picker and confirm
// where multi-provider agents pick an LLM and every agent gets an optional
// responsibility note (#174).
export type AgentsPhase = "picker" | "per-agent-config" | "confirm" | "running";

export type AgentConfigPromptKind = "llm-choice" | "responsibility-note";

export interface AgentConfigPrompt {
  agentId: string;
  kind: AgentConfigPromptKind;
}

// Flattens per-agent config requirements into a linear list. Single-provider
// agents (Claude Code, Codex) contribute only a note prompt; multi-provider
// agents (Hermes, OpenClaw) contribute an LLM choice followed by a note.
export function buildAgentConfigPromptList(
  agents: AgentEntry[],
  selectedIds: string[],
): AgentConfigPrompt[] {
  const prompts: AgentConfigPrompt[] = [];
  for (const id of selectedIds) {
    const a = agents.find((x) => x.id === id);
    if (!a) continue;
    const compat = a.llm_compat ?? [];
    if (compat.length > 1) prompts.push({ agentId: id, kind: "llm-choice" });
    prompts.push({ agentId: id, kind: "responsibility-note" });
  }
  return prompts;
}

export interface AgentConfigSubmitInput {
  currentIdx: number;
  totalPrompts: number;
}

export interface AgentConfigSubmitResult {
  nextPhase: AgentsPhase;
  nextIdx: number;
}

export function applyAgentConfigSubmit(
  input: AgentConfigSubmitInput,
): AgentConfigSubmitResult {
  const isLast = input.currentIdx + 1 >= input.totalPrompts;
  return {
    nextPhase: isLast ? "confirm" : "per-agent-config",
    nextIdx: input.currentIdx + 1,
  };
}

export interface AgentsPickerSubmitResult {
  nextPhase: AgentsPhase;
  selected: string[];
}

export function applyAgentsPickerSubmit(
  values: string[],
): AgentsPickerSubmitResult {
  return { nextPhase: "confirm", selected: values };
}

export interface AgentDiff {
  toAdd: string[];
  toRemove: string[];
}

export function computeAgentDiff(
  selected: string[],
  initialRegistered: string[],
): AgentDiff {
  const toAdd = selected.filter((id) => !initialRegistered.includes(id));
  const toRemove = initialRegistered.filter((id) => !selected.includes(id));
  return { toAdd, toRemove };
}

// Side-effecting glue between the pure phase reducer and React state +
// SecretStore. Kept module-local (not exported) because the call sites are
// only the two TextInput / PasswordInput onSubmits that share this logic.
function handleProviderValueSubmit(
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
      setSaved((prev) => [...prev, storageName]);
    } catch (err) {
      setWarning(
        `failed to store ${storageName}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  } else {
    setSkipped((prev) => [...prev, storageName]);
  }
  setWarning(result.warning);
  setIdx(result.nextIdx);
  setPhase(result.nextPhase);
  // provider is unused in this body but kept on the signature for the
  // benefit of future per-provider hooks (event emission, telemetry).
  void provider;
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

export function SetupWizard({
  initialState,
  services,
}: SetupWizardProps): JSX.Element {
  const { exit } = useApp();
  const [state, setState] = useState<SetupState>(initialState);
  const currentStep: Step = useMemo(() => {
    for (const s of [
      "welcome",
      "providers",
      "agents",
      "install",
      "policy",
      "done",
    ] as Step[]) {
      if (!state.completed.includes(s)) return s;
    }
    return "done";
  }, [state]);

  const advance = (step: Step): void => {
    setState((prev) => {
      const next = markCompleted(prev, step);
      saveSetupState(next);
      return next;
    });
  };

  const uncomplete = (step: Step): void => {
    setState((prev) => {
      const next = markUncompleted(prev, step);
      saveSetupState(next);
      return next;
    });
  };

  // Memoize the catalog so MultiSelect doesn't re-mount and reset toggles.
  const providerCatalog = useMemo(
    () => loadActiveProviders().doc.providers,
    [],
  );
  const [providersSelected, setProvidersSelected] = useState<string[]>([]);
  const [providerPrompts, setProviderPrompts] = useState<ProviderPrompt[]>([]);
  const [providerIdx, setProviderIdx] = useState(0);
  const [providersPhase, setProvidersPhase] = useState<ProvidersPhase>("picker");
  const [providersSaved, setProvidersSaved] = useState<string[]>([]);
  const [providersSkipped, setProvidersSkipped] = useState<string[]>([]);
  const [providersWarning, setProvidersWarning] = useState<string | null>(null);

  // Agents already registered in this Foreman home — drive the wizard's
  // diff logic: still-checked = no-op or re-verify; newly-checked = install;
  // previously-checked-now-unchecked = uninstall + remove.
  const initialRegistered = useMemo(
    () => services.registry.list().map((a) => a.id),
    [services.registry],
  );
  const [agentsSelected, setAgentsSelected] = useState<string[]>(() =>
    initialRegistered.length > 0 ? initialRegistered : DEFAULT_AGENTS,
  );
  const [agentsPhase, setAgentsPhase] = useState<AgentsPhase>("picker");
  // Memoize the catalog so MultiSelect doesn't re-mount on every render —
  // re-mount would reset the user's toggles back to defaultValue (#152).
  const agentCatalog = useMemo(() => loadActiveRegistry().doc.agents, []);
  const [agentConfigPrompts, setAgentConfigPrompts] = useState<
    AgentConfigPrompt[]
  >([]);
  const [agentConfigIdx, setAgentConfigIdx] = useState(0);
  const [agentConfigs, setAgentConfigs] = useState<AgentConfigsMap>({});
  const [llmDraft, setLlmDraft] = useState<string | null>(null);

  const [installLog, setInstallLog] = useState<string[]>([]);
  const [installRunning, setInstallRunning] = useState(false);
  const [installSummary, setInstallSummary] =
    useState<InstallStepSummary | null>(null);

  const [policyReview, setPolicyReview] = useState(false);
  const [donePhase, setDonePhase] = useState<"main" | "doctor" | "log">("main");
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);

  // Esc handler — phase-aware back navigation (#153). Stays out of the way
  // during install (no cancel mid-flight) and during welcome (let
  // ConfirmInput handle n=exit). Selections held in React state are
  // preserved across back-steps because we only mutate phase / completion.
  useInput((input, key) => {
    if (
      key.return &&
      currentStep === "agents" &&
      agentsPhase === "per-agent-config"
    ) {
      const prompt = agentConfigPrompts[agentConfigIdx];
      if (prompt && prompt.kind === "llm-choice") {
        const chosen = llmDraft;
        if (chosen) {
          setAgentConfigs((prev) => {
            const existing = prev[prompt.agentId] ?? {};
            return {
              ...prev,
              [prompt.agentId]: { ...existing, llmProvider: chosen },
            };
          });
        }
        const result = applyAgentConfigSubmit({
          currentIdx: agentConfigIdx,
          totalPrompts: agentConfigPrompts.length,
        });
        setAgentConfigIdx(result.nextIdx);
        setAgentsPhase(result.nextPhase);
        setLlmDraft(null);
        return;
      }
    }

    if (currentStep === "done" && donePhase === "main") {
      if (key.return) {
        exit();
        return;
      }
      if (input === "d") {
        setDoctorReport(runDoctor());
        setDonePhase("doctor");
        return;
      }
      if (input === "p") {
        void services.launchEditor(services.policyPath);
        return;
      }
      if (input === "l") {
        setDonePhase("log");
        return;
      }
      if (input === "q") {
        // Quit without launching the gateway. exec'ing process.exit instead
        // of exit() so the parent runOnboardingWizard's caller (start.ts)
        // never reaches startForeman().
        process.exit(0);
      }
    }

    if (
      key.escape &&
      currentStep === "done" &&
      (donePhase === "doctor" || donePhase === "log")
    ) {
      setDonePhase("main");
      return;
    }

    if (!key.escape) return;
    if (currentStep === "welcome") return;
    if (currentStep === "providers") {
      if (providersPhase === "values" || providersPhase === "summary") {
        setProvidersPhase("picker");
        setProviderIdx(0);
        setProvidersWarning(null);
        return;
      }
      uncomplete("welcome");
      return;
    }
    if (currentStep === "agents") {
      if (agentsPhase === "confirm") {
        setAgentsPhase("picker");
        return;
      }
      if (agentsPhase === "per-agent-config") {
        setAgentsPhase("picker");
        setAgentConfigIdx(0);
        setLlmDraft(null);
        return;
      }
      if (agentsPhase === "picker") {
        uncomplete("providers");
        setProvidersPhase("summary");
        return;
      }
      return;
    }
  });

  // ---------------- Welcome ----------------
  if (currentStep === "welcome") {
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold color={theme.accent.primary}>
          Foreman setup — 5 minutes to a working multi-agent workspace
        </Text>
        <Text color={theme.fg.muted}>
          We'll add API keys to the encrypted secret store, install the agents
          you want to wire up, inject the foreman MCP block into each agent's
          config, and review the safe-default policy.
        </Text>
        <Text>Continue? (y/n)</Text>
        <ConfirmInput
          onConfirm={() => advance("welcome")}
          onCancel={() => exit()}
        />
        <Text color={theme.fg.muted}>
          [y] continue · [n] quit
        </Text>
      </Box>
    );
  }

  // ---------------- LLM Providers — picker ----------------
  if (currentStep === "providers" && providersPhase === "picker") {
    const options = providerCatalog.map((p) => ({
      value: p.id,
      label: `${p.name} — ${p.description}`,
    }));
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold>Step 1 / 4 — LLM Providers (selection)</Text>
        <Text color={theme.fg.muted}>
          ↑↓ move · <Text bold>Space toggle</Text> · Enter confirm. Pick the
          LLM providers you already have access to. Each one stores its key
          (and endpoint, if applicable) encrypted on disk.
        </Text>
        <MultiSelect
          options={options}
          onSubmit={(values) => {
            const result = applyProvidersPickerSubmit(values);
            setProvidersSelected(result.selected);
            setProviderPrompts(
              buildProviderPromptList(providerCatalog, result.selected),
            );
            setProviderIdx(0);
            setProvidersPhase(result.nextPhase);
          }}
        />
        <Text color={theme.fg.muted}>
          [Space] toggle · [Enter] confirm · [Esc] back to welcome
        </Text>
      </Box>
    );
  }

  // ---------------- LLM Providers — value prompts ----------------
  if (currentStep === "providers" && providersPhase === "values") {
    const prompt = providerPrompts[providerIdx];
    if (!prompt) {
      setProvidersPhase("summary");
      return <Text>…</Text>;
    }
    const provider = providerCatalog.find((p) => p.id === prompt.providerId);
    if (!provider) {
      setProvidersPhase("summary");
      return <Text>…</Text>;
    }
    const storageName = storageNameForPrompt(prompt, provider);
    const isEndpoint = prompt.kind === "endpoint";
    const progress = `(${providerIdx + 1}/${providerPrompts.length})`;
    const fieldLabel = isEndpoint
      ? `${provider.name} endpoint`
      : `${provider.name} API key`;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold>
          Step 1 / 4 — LLM Providers (value {providerIdx + 1} of{" "}
          {providerPrompts.length})
        </Text>
        <Text>
          {theme.symbols.bullet} Value for{" "}
          <Text bold color={theme.accent.primary}>
            {fieldLabel}
          </Text>{" "}
          <Text color={theme.fg.muted}>{progress}</Text>
        </Text>
        {provider.where_to_get && (
          <Text color={theme.fg.muted}>
            Get yours at:{" "}
            <Text color={theme.accent.primary}>{provider.where_to_get}</Text>
          </Text>
        )}
        {provider.format_hint && (
          <Text color={theme.fg.muted}>
            Expected format:{" "}
            <Text color={theme.accent.primary}>{provider.format_hint}</Text>
          </Text>
        )}
        {provider.instructions.length > 0 && (
          <Box flexDirection="column">
            {provider.instructions.map((line, i) => (
              <Text key={i} color={theme.fg.muted}>
                {"  "}
                {i + 1}. {line}
              </Text>
            ))}
          </Box>
        )}
        <Text color={theme.fg.muted}>
          (Enter to save · Enter on empty input to skip)
        </Text>
        {providersWarning && (
          <Text color={theme.accent.warning}>⚠ {providersWarning}</Text>
        )}
        {isEndpoint ? (
          <TextInput
            defaultValue={provider.endpoint_default ?? ""}
            placeholder={provider.endpoint_default ?? "endpoint URL"}
            onSubmit={(value) => {
              handleProviderValueSubmit(
                prompt,
                provider,
                storageName,
                value,
                services,
                providerPrompts.length,
                providerIdx,
                setProvidersSaved,
                setProvidersSkipped,
                setProvidersWarning,
                setProviderIdx,
                setProvidersPhase,
              );
            }}
          />
        ) : (
          <PasswordInput
            placeholder="…"
            onSubmit={(value) => {
              handleProviderValueSubmit(
                prompt,
                provider,
                storageName,
                value,
                services,
                providerPrompts.length,
                providerIdx,
                setProvidersSaved,
                setProvidersSkipped,
                setProvidersWarning,
                setProviderIdx,
                setProvidersPhase,
              );
            }}
          />
        )}
        <Text color={theme.fg.muted}>
          [Enter] save · [Esc] back to selection
        </Text>
      </Box>
    );
  }

  // ---------------- LLM Providers — summary ----------------
  if (currentStep === "providers" && providersPhase === "summary") {
    const savedCount = providersSaved.length;
    const skippedCount = providersSkipped.length;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold>Step 1 / 4 — LLM Providers (summary)</Text>
        {savedCount > 0 ? (
          <Box flexDirection="column">
            <Text color={theme.accent.success}>
              ✓ Saved {savedCount} provider value
              {savedCount === 1 ? "" : "s"}:
            </Text>
            {providersSaved.map((name) => (
              <Text key={name} color={theme.fg.muted}>
                {"  "}• {name}
              </Text>
            ))}
          </Box>
        ) : (
          <Text color={theme.fg.muted}>
            (no providers configured — you can add them later from the LLM
            Providers page)
          </Text>
        )}
        {skippedCount > 0 && (
          <Box flexDirection="column">
            <Text color={theme.accent.warning}>
              ⚠ Skipped {skippedCount} (empty value):
            </Text>
            {providersSkipped.map((name) => (
              <Text key={name} color={theme.fg.muted}>
                {"  "}• {name}
              </Text>
            ))}
          </Box>
        )}
        <Text>Continue to agents? (y/n)</Text>
        <ConfirmInput
          onConfirm={() => advance("providers")}
          onCancel={() => advance("providers")}
        />
        <Text color={theme.fg.muted}>
          [y/n] continue · [Esc] back to selection
        </Text>
      </Box>
    );
  }

  // ---------------- Agents — picker ----------------
  if (currentStep === "agents" && agentsPhase === "picker") {
    const options = agentCatalog.map((a) => ({
      value: a.id,
      label: initialRegistered.includes(a.id)
        ? `${a.name}  (installed) — ${a.tagline}`
        : `${a.name} — ${a.tagline}`,
    }));
    const defaults =
      initialRegistered.length > 0 ? initialRegistered : DEFAULT_AGENTS;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold>Step 2 / 4 — Agents (selection)</Text>
        <Text color={theme.fg.muted}>
          ↑↓ move · <Text bold>Space toggle</Text> · Enter confirm. Defaults
          are pre-checked — toggle off any you don't want, toggle on any you
          do. Newly-checked agents are installed; previously-installed agents
          you uncheck are uninstalled.
        </Text>
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

  // ---------------- Agents — per-agent config ----------------
  if (currentStep === "agents" && agentsPhase === "per-agent-config") {
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
      const compat = agent.llm_compat ?? [];
      const options = compat.map((id) => {
        const provider = providerCatalog.find((p) => p.id === id);
        const configured = provider?.secret_name
          ? services.secretStore.exists(provider.secret_name)
          : provider
            ? services.secretStore.exists(`${provider.id}-endpoint`)
            : false;
        const label = provider
          ? `${provider.name} ${configured ? "✓" : "✗ missing"}`
          : `${id} ✗ unknown`;
        return { value: id, label };
      });
      const defaultChoice =
        compat.find((id) => {
          const provider = providerCatalog.find((p) => p.id === id);
          if (!provider) return false;
          if (provider.secret_name) {
            return services.secretStore.exists(provider.secret_name);
          }
          return services.secretStore.exists(`${provider.id}-endpoint`);
        }) ?? compat[0];
      return (
        <Box flexDirection="column" gap={1} paddingY={1}>
          <Text bold>
            Step 2 / 4 — {agent.name} {progress}
          </Text>
          <Text color={theme.fg.muted}>
            Pick the LLM provider this agent should use. Greyed entries are
            missing a key — configure one in Step 1 first if you want it.
          </Text>
          <Select
            options={options}
            defaultValue={llmDraft ?? defaultChoice}
            onChange={(value) => setLlmDraft(value)}
          />
          <Text color={theme.fg.muted}>
            [↑↓] move · [Enter] confirm · [Esc] back to selection
          </Text>
        </Box>
      );
    }
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold>
          Step 2 / 4 — {agent.name} (responsibility note) {progress}
        </Text>
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

  // ---------------- Agents — confirm ----------------
  // Show the diff before install starts. If the user's selection wasn't what
  // they expected (silent MultiSelect quirk, missed Space toggle), they get
  // one more chance to fix it.
  if (currentStep === "agents" && agentsPhase === "confirm") {
    const { toAdd, toRemove } = computeAgentDiff(
      agentsSelected,
      initialRegistered,
    );
    const noChanges = toAdd.length === 0 && toRemove.length === 0;
    const nothingSelected = agentsSelected.length === 0;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold>Step 2 / 4 — Agents (confirm)</Text>
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
          <Text color={theme.accent.warning}>
            ⚠ No agents selected — skip this step? (y/n)
          </Text>
        ) : noChanges ? (
          <Text color={theme.fg.muted}>
            (no changes — every selection is already registered)
          </Text>
        ) : (
          <Text>Proceed with install? (y/n)</Text>
        )}
        <Text color={theme.fg.muted}>
          (n / Esc returns to the selection screen)
        </Text>
        <ConfirmInput
          onConfirm={() => {
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

  // ---------------- Install ----------------
  if (currentStep === "install") {
    if (!installRunning) {
      setInstallRunning(true);
      const { toAdd, toRemove } = computeAgentDiff(
        agentsSelected,
        initialRegistered,
      );
      // Surface what's about to happen so the user catches a missed Space toggle
      // (e.g. wanted openclaw but never selected it) before install starts.
      setInstallLog(
        [
          `Selected agents: ${agentsSelected.length > 0 ? agentsSelected.join(", ") : "(none)"}`,
          ...(toAdd.length > 0
            ? [`▸ Will install: ${toAdd.join(", ")}`]
            : []),
          ...(toRemove.length > 0
            ? [`▸ Will remove: ${toRemove.join(", ")}`]
            : []),
          toAdd.length === 0 && toRemove.length === 0
            ? "▸ No changes — every selection is already registered."
            : "",
        ].filter(Boolean),
      );
      void runInstallStep(
        toAdd,
        toRemove,
        services,
        (line) => setInstallLog((prev) => [...prev, line]),
        agentConfigs,
      ).then((summary) => {
        setInstallSummary(summary);
        advance("install");
      });
    }
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold>Step 3 / 4 — Install + configure</Text>
        {installLog.map((line, i) => {
          const isError = line.trimStart().startsWith("✗");
          const isWarning = line.trimStart().startsWith("⚠");
          const color = isError
            ? theme.accent.danger
            : isWarning
              ? theme.accent.warning
              : undefined;
          return (
            <Text key={i} color={color}>
              {line}
            </Text>
          );
        })}
        <Text color={theme.fg.muted}>
          (install running — back-navigation disabled mid-flight)
        </Text>
      </Box>
    );
  }

  // ---------------- Policy ----------------
  if (currentStep === "policy") {
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold>Step 4 / 4 — Policy</Text>
        <Text color={theme.fg.muted}>
          Foreman ships safe defaults (asks before any agent reads .env-shaped
          files or runs destructive shell). Want to review {services.policyPath}{" "}
          now? (y/n)
        </Text>
        <ConfirmInput
          onConfirm={async () => {
            setPolicyReview(true);
            await services.launchEditor(services.policyPath);
            advance("policy");
          }}
          onCancel={() => advance("policy")}
        />
      </Box>
    );
  }

  // ---------------- Done ----------------
  void policyReview;
  const storedNames = new Set(
    services.secretStore.list().map((s) => s.name),
  );
  const providerIds = configuredProviderIds(providerCatalog, storedNames);
  const serviceCatalog = loadActiveServices().doc.services;
  const serviceIds = configuredServiceIds(serviceCatalog, storedNames);
  const agentRows = services.registry.list();
  const policyRuleCount = countPolicyRules(services.policyPath);

  if (donePhase === "doctor" && doctorReport) {
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold color={theme.accent.primary}>
          foreman doctor
        </Text>
        {doctorReport.checks.map((c) => {
          const icon =
            c.status === "ok" ? "✓" : c.status === "warn" ? "⚠" : "✗";
          const color =
            c.status === "ok"
              ? theme.accent.success
              : c.status === "warn"
                ? theme.accent.warning
                : theme.accent.danger;
          return (
            <Text key={c.name} color={color}>
              {"  "}
              {icon} {c.name.padEnd(20)} {c.message}
            </Text>
          );
        })}
        <Text color={theme.fg.muted}>
          (exit code {doctorReport.exitCode}) — [Esc] back
        </Text>
      </Box>
    );
  }

  if (donePhase === "log") {
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold color={theme.accent.primary}>
          Install log
        </Text>
        {installLog.map((line, i) => {
          const trimmed = line.trimStart();
          const color = trimmed.startsWith("✗")
            ? theme.accent.danger
            : trimmed.startsWith("⚠")
              ? theme.accent.warning
              : undefined;
          return (
            <Text key={i} color={color}>
              {line}
            </Text>
          );
        })}
        <Text color={theme.fg.muted}>[Esc] back</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1} paddingY={1}>
      <StatusMessage variant="success">
        Setup complete — Foreman is ready to guard your agents.
      </StatusMessage>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Summary</Text>
        <Text color={theme.fg.muted}>
          {"  "}
          {providerIds.length} LLM provider
          {providerIds.length === 1 ? "" : "s"}
          {providerIds.length > 0 ? `   ${providerIds.join(", ")}` : ""}
        </Text>
        <Text color={theme.fg.muted}>
          {"  "}
          {agentRows.length} agent{agentRows.length === 1 ? "" : "s"}
          {agentRows.length > 0
            ? `         ${agentRows.map((a) => a.id).join(", ")}`
            : ""}
        </Text>
        <Text color={theme.fg.muted}>
          {"  "}
          {serviceIds.length} service{serviceIds.length === 1 ? "" : "s"}
          {serviceIds.length > 0 ? `       ${serviceIds.join(", ")}` : ""}
        </Text>
        <Text color={theme.fg.muted}>
          {"  "}
          {policyRuleCount} policy rule
          {policyRuleCount === 1 ? "" : "s"}   smart defaults active
        </Text>
      </Box>
      {installSummary && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.fg.muted}>
            Foreman identity pushed to{" "}
            {installSummary.identityPushed.length} of{" "}
            {installSummary.registered.length} agent
            {installSummary.registered.length === 1 ? "" : "s"}
            {installSummary.identitySkipped.length > 0
              ? ` (${installSummary.identitySkipped.length} skipped)`
              : ""}
            .
          </Text>
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>What next?</Text>
        <Text color={theme.fg.muted}>
          {"  "}[Enter] Launch Foreman TUI
        </Text>
        <Text color={theme.fg.muted}>{"  "}[d]     Run foreman doctor</Text>
        <Text color={theme.fg.muted}>
          {"  "}[p]     Review policy file
        </Text>
        <Text color={theme.fg.muted}>{"  "}[l]     Show install log</Text>
        <Text color={theme.fg.muted}>{"  "}[q]     Exit</Text>
      </Box>
    </Box>
  );
}

// Exported for tests. The wizard's core diff loop: install + register the
// newly-checked agents, uninstall + remove the previously-checked-now-unchecked
// ones. Idempotent — running it twice with the same toAdd/toRemove no-ops.
// Returns the ids of catalog entries whose required secrets/endpoints are
// present in the store. Used by the Done screen to render real counts for
// providers and services rather than a fragile string parse of install log.
export function configuredProviderIds(
  providers: ProviderEntry[],
  storedNames: Set<string>,
): string[] {
  return providers
    .filter((p) => {
      if (p.secret_name && storedNames.has(p.secret_name)) return true;
      if (p.endpoint_required && storedNames.has(`${p.id}-endpoint`))
        return true;
      return false;
    })
    .map((p) => p.id);
}

export function configuredServiceIds(
  services: { id: string; secret_name: string }[],
  storedNames: Set<string>,
): string[] {
  return services
    .filter((s) => storedNames.has(s.secret_name))
    .map((s) => s.id);
}

// Read the policy.yaml rule count without instantiating a PolicyEngine.
// Returns 0 on missing / malformed file rather than throwing — the Done
// screen is best-effort reporting, not the canonical policy validator.
export function countPolicyRules(policyPath: string): number {
  if (!existsSync(policyPath)) return 0;
  try {
    const parsed = parseYaml(readFileSync(policyPath, "utf-8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "rules" in parsed &&
      Array.isArray((parsed as { rules: unknown[] }).rules)
    ) {
      return (parsed as { rules: unknown[] }).rules.length;
    }
    return 0;
  } catch {
    return 0;
  }
}

export interface AgentConfig {
  llmProvider?: string;
  responsibilityNote?: string;
}

export type AgentConfigsMap = Record<string, AgentConfig | undefined>;

export interface InstallStepSummary {
  registered: string[];
  identityPushed: string[];
  identitySkipped: { agentId: string; reason: string }[];
  failed: string[];
  removed: string[];
}

export async function runInstallStep(
  toAdd: string[],
  toRemove: string[],
  services: WizardServices,
  log: (line: string) => void,
  agentConfigs: AgentConfigsMap = {},
): Promise<InstallStepSummary> {
  const summary: InstallStepSummary = {
    registered: [],
    identityPushed: [],
    identitySkipped: [],
    failed: [],
    removed: [],
  };
  const { doc } = loadActiveRegistry();

  // --- Process unchecks first: uninstall the binary, remove the row -----
  for (const id of toRemove) {
    const existing = services.registry.get(id);
    if (!existing) continue;
    const registryId =
      typeof existing.metadata?.registryId === "string"
        ? existing.metadata.registryId
        : null;
    const entry = registryId ? safeFind(doc, registryId) : null;
    log(`▸ Removing ${existing.displayName}`);
    services.registry.remove(id);
    summary.removed.push(id);
    log(`  ✓ unregistered "${id}"`);
    if (entry) {
      const cmd = preferredUninstallCommand(entry.install);
      if (cmd) {
        log(`  uninstalling (${cmd})…`);
        const result = await runUninstall({
          install: entry.install,
          onLine: (l) => log(`  ${l}`),
        });
        if (result.ok) log(`  ✓ ${entry.name} uninstalled`);
        else log(`  ⚠ uninstall failed (exit ${result.exitCode}); run manually: ${result.manualCommand}`);
      } else if (entry.install.script) {
        log(
          `  ⚠ ${entry.name} was installed via a script — remove the ${entry.install.binary ?? id} binary manually.`,
        );
      }
    }
  }

  // --- Then add: install, configure, register ---------------------------
  for (const id of toAdd) {
    let entry: AgentEntry;
    try {
      entry = findAgent(doc, id);
    } catch {
      log(`✗ ${id}: not in registry — skipped`);
      continue;
    }
    log(`▸ ${entry.name}`);

    // Each substep is best-effort — install / secret-check / config-inject
    // failures degrade to a warning, but registration always runs at the end.
    const detection = detectInstall(entry.install);
    if (!detection.found) {
      const installCmd = entry.install.npm
        ? `npm install -g ${entry.install.npm}`
        : entry.install.brew
          ? `brew install ${entry.install.brew}`
          : entry.install.script
            ? `curl -fsSL ${entry.install.script} | bash`
            : null;
      if (installCmd) {
        log(`  installing (${installCmd})…`);
        const result = await runInstall({
          install: entry.install,
          onLine: (l) => log(`  ${l}`),
        });
        if (!result.ok) {
          log(`  ⚠ install failed (exit ${result.exitCode})`);
          log(`    run manually: ${result.manualCommand}`);
        }
      }
    } else {
      log(`  ✓ already installed at ${detection.path}`);
    }

    const secretCheck = checkSecrets(entry, services.secretStore);
    if (!secretCheck.hasAllRequired) {
      const missing = secretCheck.required
        .filter((s) => !s.present)
        .map((s) => s.name);
      log(
        `  ⚠ required secrets missing: ${missing.join(", ")} — add via 'foreman secrets add <name>'`,
      );
    }

    const configPath = pickConfigPath(entry);
    if (configPath) {
      try {
        const snippet = buildMcpSnippet(id, entry);
        const plan = planInjection(configPath, snippet.json);
        if (plan.alreadyHasForeman) {
          log(`  ✓ config already wired at ${configPath}`);
        } else {
          applyInjection(configPath, plan);
          log(`  ✓ wrote MCP snippet to ${configPath}`);
        }
      } catch (err) {
        if (err instanceof UnsupportedConfigFormatError) {
          log(`  ⚠ ${configPath} unsupported format — paste manually`);
        } else {
          log(
            `  ⚠ config inject skipped: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    if (services.registry.get(id)) {
      log(`  ◦ already registered`);
      continue;
    }
    try {
      const cfg = agentConfigs[id];
      registerAgent({
        agentId: id,
        entry,
        registry: services.registry,
        llmProvider: cfg?.llmProvider,
        responsibilityNote: cfg?.responsibilityNote,
      });
      summary.registered.push(id);
      log(`  ✓ registered as "${id}"`);
      if (cfg?.llmProvider) log(`    LLM provider: ${cfg.llmProvider}`);
      if (cfg?.responsibilityNote)
        log(`    Responsibility: ${cfg.responsibilityNote}`);
      if (entry.identity_path) {
        try {
          const soulResult = applyForemanSoul(
            entry,
            getForemanPaths().soulPath,
          );
          if (soulResult?.changed) {
            summary.identityPushed.push(id);
            log(`  ✓ wrote Foreman identity to ${soulResult.path}`);
          }
        } catch (err) {
          const reason =
            err instanceof Error ? err.message : String(err);
          summary.identitySkipped.push({ agentId: id, reason });
          log(`  ⚠ identity write skipped: ${reason}`);
        }
      } else {
        summary.identitySkipped.push({
          agentId: id,
          reason: "no identity_path in registry entry",
        });
      }
    } catch (err) {
      summary.failed.push(id);
      log(
        `  ✗ register failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (toAdd.length === 0 && toRemove.length === 0) {
    log("(no agent changes — selection matches current registration)");
  }

  return summary;
}

function safeFind(
  doc: ReturnType<typeof loadActiveRegistry>["doc"],
  id: string,
): AgentEntry | null {
  try {
    return findAgent(doc, id);
  } catch {
    return null;
  }
}
