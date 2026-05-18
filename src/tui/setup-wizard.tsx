import { existsSync, readFileSync } from "node:fs";
import { Box, Text, useApp, useInput } from "ink";
import { parse as parseYaml } from "yaml";
import {
  ConfirmInput,
  MultiSelect,
  PasswordInput,
  StatusMessage,
  TextInput,
} from "@inkjs/ui";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { projectSecretsForAgent } from "../core/agent-secrets-projector.js";
import {
  detectProviderConflict,
  formatConflictWarning,
} from "../core/agent-provider-conflict.js";
import { WizardProgress } from "./components/wizard-progress.js";
import {
  detectInstall,
  preferredUninstallCommand,
  runInstall,
  runUninstall,
} from "../core/agent-install.js";
import { buildMcpSnippet } from "../core/agent-mcp-snippet.js";
import {
  buildMcpRegisterHint,
  writeMcpWrapperScript,
} from "../core/agent-mcp-register-hint.js";
import {
  findAgent,
  loadActiveProviders,
  loadActiveRegistry,
  loadActiveServices,
  type AgentEntry,
  type ProviderEntry,
  type ServiceEntry,
} from "../core/registry-catalog.js";
import { runDoctor, type DoctorReport } from "../core/doctor.js";
import {
  defaultLlmConfig,
  loadLlmConfig,
  saveLlmConfig,
} from "../core/llm/config.js";
import {
  defaultNotifyConfig,
  loadNotifyConfig,
  saveNotifyConfig,
} from "../core/notification/notify-config.js";
import { applyForemanSoul } from "../core/foreman-soul.js";
import { buildLlmConfigFromWizard } from "./setup-wizard-llm-persist.js";
import { buildNotifyConfigFromWizard } from "./setup-wizard-notify-persist.js";
import { validateKeyPaste } from "./setup-wizard-key-validation.js";
import { computeAgentLlmStatuses } from "./setup-wizard-agent-llm-gating.js";
import { persistVoiceConfig } from "./setup-wizard-voice-persist.js";
import { useLayout } from "./hooks.js";
import { osc8 } from "./osc8.js";
import { blockFallbackFrame } from "./components/mascot-frames.js";
import { RegistryService } from "../core/registry.js";
import { SecretStore } from "../core/secret-store.js";
import type { ForemanDb } from "../db/client.js";
import { getForemanPaths } from "../utils/config.js";
import {
  markCompleted,
  markUncompleted,
  saveSetupState,
  STEPS,
  type SetupState,
  type Step,
} from "./setup-state.js";
import { singleBorder, theme } from "./theme.js";

const DEFAULT_AGENTS = ["hermes", "claude-code"];

export interface WelcomeStep {
  number: number;
  name: string;
  estimateMinutes: number;
  optional?: boolean;
}

// Step preview rendered on the Welcome screen. Names must line up with
// the actual step labels in the rest of the wizard so the user's mental
// model from this screen matches what they see in Steps 1–4.
export const WELCOME_STEPS: WelcomeStep[] = [
  { number: 1, name: "LLM Providers", estimateMinutes: 2 },
  { number: 2, name: "Agents", estimateMinutes: 2 },
  { number: 3, name: "Services", estimateMinutes: 1, optional: true },
  { number: 4, name: "Install + Verify", estimateMinutes: 3 },
];

export function totalEstimatedMinutes(
  steps: readonly WelcomeStep[] = WELCOME_STEPS,
): number {
  return steps.reduce((sum, s) => sum + s.estimateMinutes, 0);
}

// Welcome-screen mascot. Reuses the boot-time block-character frame
// (#365) so the wizard's first impression matches the post-boot
// dashboard the user sees seconds later. Static — no morph/blink — to
// keep the welcome screen quiet. Rendered only on terminals wide enough
// for the side-by-side layout (>= 80 cols).
const WELCOME_MASCOT = blockFallbackFrame(false).lines;

export interface WizardServices {
  db: ForemanDb;
  secretStore: SecretStore;
  registry: RegistryService;
  policyPath: string;
  /** Path to llm.yaml — wizard writes here after providers step (#289). */
  llmConfigPath: string;
  /** Path to notify.yaml — wizard writes here after services step (#290). */
  notifyConfigPath: string;
  /** Path to voice.yaml — wizard seeds here after services step (#305).
   *  ForemanVoice + PatternDetectionService read from this on startup. */
  voiceConfigPath: string;
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
//
// The `configuredProviderIds` arg (added in #297) gates the llm-choice
// prompt — if the user has only one of the agent's compatible LLMs
// configured, there's nothing to pick and we skip the prompt. When omitted,
// the original "compat > 1 → ask" behaviour holds (used by callers / tests
// that don't have wizard state).
export function buildAgentConfigPromptList(
  agents: AgentEntry[],
  selectedIds: string[],
  configuredProviderIds?: string[],
): AgentConfigPrompt[] {
  const prompts: AgentConfigPrompt[] = [];
  const configured = configuredProviderIds
    ? new Set(configuredProviderIds)
    : null;
  for (const id of selectedIds) {
    const a = agents.find((x) => x.id === id);
    if (!a) continue;
    const compat = a.llm_compat ?? [];
    const choosable = configured
      ? compat.filter((p) => configured.has(p))
      : compat;
    // #355 — show the llm-choice picker whenever the agent supports
    // multiple providers AND at least one of them is configured. Previously
    // we skipped when `choosable.length === 1`, which silently picked the
    // sole option without telling the user. Round-3 users had only one
    // provider configured and never saw the picker, so they couldn't tell
    // which LLM each agent ended up wired to (and felt they had no choice
    // even when they later added a second provider). Single-option pickers
    // are a 1-keystroke confirm — that's the right cost.
    if (compat.length > 1 && choosable.length >= 1) {
      prompts.push({ agentId: id, kind: "llm-choice" });
    }
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

export type ServicesPhase = "picker" | "values" | "summary";

export interface ServicesPickerSubmitResult {
  nextPhase: ServicesPhase;
  selected: string[];
}

export function applyServicesPickerSubmit(
  values: string[],
): ServicesPickerSubmitResult {
  if (values.length === 0) {
    return { nextPhase: "summary", selected: [] };
  }
  return { nextPhase: "values", selected: values };
}

// One value-entry prompt during Step 3. Each selected service expands into
// one prompt for its primary secret plus one per `extra_secrets` entry, so
// a service like Telegram (bot token + chat id) emits two prompts (#220).
export interface ServicePrompt {
  serviceId: string;
  secretName: string;
  kind: "primary" | "extra";
  /** Display label shown in the header / summary lists. */
  label: string;
  whereToGet: string | null;
  formatHint: string;
  setupSteps: string[];
  /** Skippable? Primary defaults to required (kept as today); extras default
   *  to optional so a fresh user can configure later from the Secrets page. */
  optional: boolean;
}

export function buildServicePromptList(
  serviceIds: string[],
  catalog: ServiceEntry[],
): ServicePrompt[] {
  const out: ServicePrompt[] = [];
  for (const id of serviceIds) {
    const svc = catalog.find((s) => s.id === id);
    if (!svc) continue;
    out.push({
      serviceId: svc.id,
      secretName: svc.secret_name,
      kind: "primary",
      label: svc.name,
      whereToGet: svc.where_to_get,
      formatHint: svc.format_hint,
      setupSteps: svc.setup_steps,
      // Primary is still skippable today (user can Enter on empty to bypass)
      // so we keep optional=true to match the existing UX message.
      optional: true,
    });
    for (const extra of svc.extra_secrets ?? []) {
      out.push({
        serviceId: svc.id,
        secretName: extra.name,
        kind: "extra",
        label: extra.description ?? `${svc.name} — ${extra.name}`,
        whereToGet: extra.where_to_get ?? null,
        formatHint: extra.format_hint,
        setupSteps: extra.setup_steps,
        optional: extra.optional,
      });
    }
  }
  return out;
}

export interface ServiceValueSubmitInput {
  serviceId: string;
  value: string;
  currentIdx: number;
  totalSelected: number;
}

export interface ServiceValueSubmitResult {
  shouldSave: boolean;
  warning: string | null;
  nextPhase: ServicesPhase;
  nextIdx: number;
}

export function applyServiceValueSubmit(
  input: ServiceValueSubmitInput,
): ServiceValueSubmitResult {
  const isLast = input.currentIdx + 1 >= input.totalSelected;
  if (input.value.length === 0) {
    return {
      shouldSave: false,
      warning: `Skipped ${input.serviceId} — empty value. Add it later from the Services page.`,
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

// Intersect a service's used_by_agents with the agents the user picked in
// Step 2 — the wizard hasn't installed them yet, so registry.list() would
// be empty here. Returns the matching ids in agent-catalog order.
export function consumingAgentsFor(
  service: ServiceEntry,
  agentsSelected: string[],
): string[] {
  return service.used_by_agents.filter((id) => agentsSelected.includes(id));
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
function persistLlmConfigFromWizardState(
  services: WizardServices,
  providerCatalog: ProviderEntry[],
  savedStorageNames: string[],
): void {
  if (savedStorageNames.length === 0) return;
  try {
    // loadLlmConfig falls back to defaults when the file doesn't exist, so
    // we always get a typed LlmConfig to merge into.
    const existing = loadLlmConfig(services.llmConfigPath);
    const { next, wiredProviders } = buildLlmConfigFromWizard({
      savedStorageNames,
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

// Sibling of persistLlmConfigFromWizardState (#289) — writes notify.yaml
// after the services step so the wizard's "✓ wired N services" claim
// actually translates to enabled channels. Same best-effort semantics:
// merge into existing config, fall back to defaults on parse error, log
// but don't crash on write failure.
function persistNotifyConfigFromWizardState(
  services: WizardServices,
  serviceCatalog: ServiceEntry[],
  savedStorageNames: string[],
): void {
  if (savedStorageNames.length === 0) return;
  try {
    const existing = loadNotifyConfig(services.notifyConfigPath);
    const { next, wiredChannels } = buildNotifyConfigFromWizard({
      savedStorageNames,
      serviceCatalog,
      secretStore: services.secretStore,
      existing,
    });
    if (wiredChannels.length === 0) return;
    saveNotifyConfig(services.notifyConfigPath, next);
  } catch (err) {
    try {
      const { next } = buildNotifyConfigFromWizard({
        savedStorageNames,
        serviceCatalog,
        secretStore: services.secretStore,
        existing: defaultNotifyConfig(),
      });
      saveNotifyConfig(services.notifyConfigPath, next);
    } catch (writeErr) {
      console.error(
        `⚠ failed to persist notify.yaml: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        `(original error: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
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
  const welcomeLayout = useLayout();
  const currentStep: Step = useMemo(() => {
    for (const s of STEPS) {
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

  // #358 — Computed once per relevant state change so both render and the
  // useInput handler operate on the same ordered list. Empty array when
  // we're not in the llm-choice phase, so callers can early-return.
  const llmPickerOptions = useMemo<string[]>(() => {
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

  const serviceCatalog = useMemo(() => loadActiveServices().doc.services, []);
  const [servicesSelected, setServicesSelected] = useState<string[]>([]);
  const [serviceIdx, setServiceIdx] = useState(0);
  const [servicesPhase, setServicesPhase] = useState<ServicesPhase>("picker");
  const [servicesSaved, setServicesSaved] = useState<string[]>([]);
  const [servicesSkipped, setServicesSkipped] = useState<string[]>([]);
  const [servicesWarning, setServicesWarning] = useState<string | null>(null);

  const [installLog, setInstallLog] = useState<string[]>([]);
  const [installRunning, setInstallRunning] = useState(false);
  const [installSummary, setInstallSummary] =
    useState<InstallStepSummary | null>(null);
  const [pendingFailure, setPendingFailure] =
    useState<AgentInstallFailure | null>(null);
  const [manualFixOpen, setManualFixOpen] = useState(false);
  const failureResolverRef = useRef<
    ((resolution: FailureResolution) => void) | null
  >(null);

  const [donePhase, setDonePhase] = useState<"main" | "doctor" | "log">("main");
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);

  // Esc handler — phase-aware back navigation (#153). Stays out of the way
  // during install (no cancel mid-flight) and during welcome (let
  // ConfirmInput handle n=exit). Selections held in React state are
  // preserved across back-steps because we only mutate phase / completion.
  useInput((input, key) => {
    // #358 — Per-agent LLM picker key handling. ↑↓ live-updates the
    // selection (cursor + ✓ travel together — round-3 muscle memory
    // expectation), Space or Enter commits and advances. The render side
    // pulls from llmDraft so updating it re-renders the radio in place.
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
          return;
        }
        if (key.downArrow) {
          const nextIdx = (currentIdx + 1) % llmPickerOptions.length;
          setLlmDraft(llmPickerOptions[nextIdx] ?? null);
          return;
        }
        if (key.return || input === " ") {
          const chosen = llmDraft ?? llmPickerOptions[0];
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

    if (currentStep === "welcome") {
      if (key.return) {
        advance("welcome");
        return;
      }
      if (input === "q") {
        exit();
        return;
      }
      // Esc on welcome: defer to the user. We don't auto-exit because the
      // user might be exploring; a deliberate `q` is the affordance.
      return;
    }

    // Install-failure prompt (#177). When pendingFailure is set, runInstall
    // is awaiting a resolution — [r] retry, [s] skip, [m] open manual-fix
    // overlay. Esc on the overlay just closes it (re-shows the prompt).
    if (pendingFailure) {
      if (manualFixOpen) {
        if (key.escape) setManualFixOpen(false);
        return;
      }
      if (input === "r") {
        failureResolverRef.current?.("retry");
        failureResolverRef.current = null;
        setPendingFailure(null);
        return;
      }
      if (input === "s") {
        failureResolverRef.current?.("skip");
        failureResolverRef.current = null;
        setPendingFailure(null);
        return;
      }
      if (input === "m") {
        setManualFixOpen(true);
        return;
      }
      return;
    }

    if (!key.escape) return;
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
    if (currentStep === "services") {
      if (servicesPhase === "values" || servicesPhase === "summary") {
        setServicesPhase("picker");
        setServiceIdx(0);
        setServicesWarning(null);
        return;
      }
      // picker → agents confirm (the most recent agents phase)
      uncomplete("agents");
      setAgentsPhase("confirm");
      return;
    }
  });

  // ---------------- Welcome ----------------
  if (currentStep === "welcome") {
    const total = totalEstimatedMinutes();
    const stepList = (
      <Box flexDirection="column">
        <Text bold color={theme.accent.primary}>
          Welcome to Foreman
        </Text>
        <Text color={theme.fg.muted}>
          Foreman is the single pane of glass for your AI agent setup.
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.fg.default}>
            We'll wire this up in {WELCOME_STEPS.length} steps:
          </Text>
          {WELCOME_STEPS.map((s) => (
            <Text key={s.number} color={theme.fg.muted}>
              {"  "}
              {s.number}. {s.name.padEnd(18, " ")}~{s.estimateMinutes} min
              {s.optional ? "  (optional)" : ""}
            </Text>
          ))}
          <Text color={theme.fg.muted}>
            {"  "}Total time: about {total} minutes.
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.fg.muted}>
            Quit any time with Ctrl-C and resume with `foreman setup --resume`.
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text>[Enter] Start setup     [q] Quit</Text>
        </Box>
      </Box>
    );
    if (welcomeLayout === "narrow") {
      return <Box paddingY={1}>{stepList}</Box>;
    }
    return (
      <Box paddingY={1}>
        <Box flexDirection="column" marginRight={2}>
          {WELCOME_MASCOT.map((row, i) => (
            <Text key={i} color={theme.accent.primary}>
              {row}
            </Text>
          ))}
        </Box>
        {stepList}
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
        <WizardProgress current={1} total={4} label="LLM Providers" phase="pick which to configure" />
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
        <WizardProgress
          current={1}
          total={4}
          label="LLM Providers"
          phase={`value ${providerIdx + 1} of ${providerPrompts.length} ${theme.symbols.bullet} ${provider.name}`}
        />
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
          // key= forces a fresh mount per prompt so the field never keeps the
          // previous provider's value (#219). Stable id includes the kind so
          // an endpoint+key combo for the same provider also gets two clean mounts.
          <TextInput
            key={`prov:${prompt.providerId}:${prompt.kind}`}
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
            key={`prov:${prompt.providerId}:${prompt.kind}`}
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
        <WizardProgress current={1} total={4} label="LLM Providers" phase="summary" />
        {savedCount > 0 ? (
          <Box flexDirection="column">
            <Text color={theme.accent.success}>
              ✓ Saved {savedCount} provider value
              {savedCount === 1 ? "" : "s"}:
            </Text>
            {providersSaved.map((name, idx) => (
              // #341 — compound key so a re-saved name (user backed out + re-
              // entered the same prompt) doesn't collide with itself.
              <Text key={`${name}:${idx}`} color={theme.fg.muted}>
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
            {providersSkipped.map((name, idx) => (
              <Text key={`${name}:${idx}`} color={theme.fg.muted}>
                {"  "}• {name}
              </Text>
            ))}
          </Box>
        )}
        <Text>Continue to agents? (y/n)</Text>
        <ConfirmInput
          onConfirm={() => {
            persistLlmConfigFromWizardState(services, providerCatalog, providersSaved);
            advance("providers");
          }}
          onCancel={() => {
            persistLlmConfigFromWizardState(services, providerCatalog, providersSaved);
            advance("providers");
          }}
        />
        <Text color={theme.fg.muted}>
          [y/n] continue · [Esc] back to selection
        </Text>
      </Box>
    );
  }

  // ---------------- Agents — picker ----------------
  if (currentStep === "agents" && agentsPhase === "picker") {
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
    // showed them with a `⚠ needs X key` suffix but kept them togglable,
    // so round-3 users could Space-check Claude Code without an Anthropic
    // key and end up with a registered-but-401-on-every-call install.
    // Hidden agents are listed at the top with the unlock path so the user
    // can step back (Esc) to Step 1 and add the missing key.
    const hiddenAgents = agentCatalog.filter(
      (a) => gatingStatuses.get(a.id)?.state === "needs-llm",
    );
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
        {hiddenAgents.length > 0 && (
          <Box flexDirection="column">
            <Text color={theme.accent.warning}>
              ⚠ Hidden — add a key in Step 1 (Esc) to unlock:
            </Text>
            {hiddenAgents.map((a) => {
              const status = gatingStatuses.get(a.id);
              return (
                <Text key={a.id} color={theme.fg.muted}>
                  {"   "}
                  {a.name} ({status?.hint ?? "needs an LLM key"})
                </Text>
              );
            })}
          </Box>
        )}
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
      // memory. The ↑↓ / Space / Enter handlers live in the wizard's main
      // useInput at line ~678.
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
          <Text color={theme.accent.warning}>
            ⚠ No agents selected — skip this step? (y/n)
          </Text>
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

  // ---------------- Services — picker ----------------
  if (currentStep === "services" && servicesPhase === "picker") {
    const options = serviceCatalog.map((s) => {
      const consumers = consumingAgentsFor(s, agentsSelected);
      const usedBy =
        consumers.length > 0
          ? `Used by: ${consumers.join(", ")}`
          : "(no installed agents use this — you can add it anyway)";
      return {
        value: s.id,
        label: `${s.name} — ${usedBy}`,
      };
    });
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress current={3} total={4} label="Services" phase="pick which to configure" />
        <Text color={theme.fg.muted}>
          ↑↓ move · <Text bold>Space toggle</Text> · Enter confirm. 3rd-party
          tokens (Telegram, Discord, Slack, GitHub, …). Each one stores its
          token encrypted on disk and gets handed to consuming agents on
          demand. Skippable — leave empty + Enter to bypass.
        </Text>
        <MultiSelect
          options={options}
          onSubmit={(values) => {
            const result = applyServicesPickerSubmit(values);
            setServicesSelected(result.selected);
            setServiceIdx(0);
            setServicesPhase(result.nextPhase);
          }}
        />
        <Text color={theme.fg.muted}>
          [Space] toggle · [Enter] continue · [Esc] back to agents
        </Text>
      </Box>
    );
  }

  // ---------------- Services — value prompts ----------------
  if (currentStep === "services" && servicesPhase === "values") {
    // Flatten selected services → one prompt per (primary + each extra
    // secret). Telegram emits two prompts: bot token, then chat id (#220).
    const servicePrompts = buildServicePromptList(
      servicesSelected,
      serviceCatalog,
    );
    const prompt = servicePrompts[serviceIdx];
    if (!prompt) {
      setServicesPhase("summary");
      return <Text>…</Text>;
    }
    const service = serviceCatalog.find((s) => s.id === prompt.serviceId);
    if (!service) {
      setServicesPhase("summary");
      return <Text>…</Text>;
    }
    const progress = `(${serviceIdx + 1}/${servicePrompts.length})`;
    const headerLabel =
      prompt.kind === "extra"
        ? `${service.name} — ${prompt.secretName}`
        : service.name;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          current={3}
          total={4}
          label="Services"
          phase={`prompt ${serviceIdx + 1} of ${servicePrompts.length} ${theme.symbols.bullet} ${headerLabel}`}
        />
        <Text>
          {theme.symbols.bullet} Setting up{" "}
          <Text bold color={theme.accent.primary}>
            {headerLabel}
          </Text>{" "}
          <Text color={theme.fg.muted}>{progress}</Text>
        </Text>
        {prompt.whereToGet ? (
          <Text color={theme.fg.muted}>
            Get yours at:{" "}
            <Text color={theme.accent.primary}>
              {service.open_url_hotkey
                ? osc8(prompt.whereToGet)
                : prompt.whereToGet}
            </Text>
          </Text>
        ) : null}
        <Text color={theme.fg.muted}>
          Expected format:{" "}
          <Text color={theme.accent.primary}>{prompt.formatHint}</Text>
        </Text>
        {prompt.setupSteps.length > 0 && (
          <Box flexDirection="column">
            {prompt.setupSteps.map((line, i) => (
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
        {servicesWarning && (
          <Text color={theme.accent.warning}>⚠ {servicesWarning}</Text>
        )}
        <PasswordInput
          // Remount per secret so the previous token doesn't bleed into the next prompt (#219).
          key={`service:${prompt.secretName}`}
          placeholder="…"
          onSubmit={(value) => {
            const result = applyServiceValueSubmit({
              serviceId: prompt.secretName,
              value,
              currentIdx: serviceIdx,
              totalSelected: servicePrompts.length,
            });
            if (result.shouldSave) {
              try {
                if (!services.secretStore.exists(prompt.secretName)) {
                  services.secretStore.add(prompt.secretName, value);
                } else {
                  services.secretStore.rotate(prompt.secretName, value);
                }
                // #341 — dedupe so re-save doesn't double the entry +
                // collide as a React key in the services summary render.
                setServicesSaved((prev) =>
                  prev.includes(prompt.secretName)
                    ? prev
                    : [...prev, prompt.secretName],
                );
              } catch (err) {
                setServicesWarning(
                  `failed to store ${prompt.secretName}: ${err instanceof Error ? err.message : String(err)}`,
                );
                return;
              }
            } else {
              setServicesSkipped((prev) =>
                prev.includes(prompt.secretName)
                  ? prev
                  : [...prev, prompt.secretName],
              );
            }
            setServicesWarning(result.warning);
            setServiceIdx(result.nextIdx);
            setServicesPhase(result.nextPhase);
          }}
        />
        <Text color={theme.fg.muted}>
          [Enter] save · [Esc] back to selection
        </Text>
      </Box>
    );
  }

  // ---------------- Services — summary ----------------
  if (currentStep === "services" && servicesPhase === "summary") {
    const savedCount = servicesSaved.length;
    const skippedCount = servicesSkipped.length;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress current={3} total={4} label="Services" phase="summary" />
        {savedCount > 0 ? (
          <Box flexDirection="column">
            <Text color={theme.accent.success}>
              ✓ Wired {savedCount} service{savedCount === 1 ? "" : "s"}:
            </Text>
            {servicesSaved.map((name, idx) => (
              // #341 — compound key so a re-saved name doesn't collide.
              <Text key={`${name}:${idx}`} color={theme.fg.muted}>
                {"  "}• {name}
              </Text>
            ))}
          </Box>
        ) : (
          <Text color={theme.fg.muted}>
            (no services configured — you can add them later from the
            Services page)
          </Text>
        )}
        {skippedCount > 0 && (
          <Box flexDirection="column">
            <Text color={theme.accent.warning}>
              ⚠ Skipped {skippedCount} (empty value):
            </Text>
            {servicesSkipped.map((name, idx) => (
              <Text key={`${name}:${idx}`} color={theme.fg.muted}>
                {"  "}• {name}
              </Text>
            ))}
          </Box>
        )}
        <Text>Continue to install? (y/n)</Text>
        <ConfirmInput
          onConfirm={() => {
            persistNotifyConfigFromWizardState(services, serviceCatalog, servicesSaved);
            // #305 — seed voice.yaml alongside notify.yaml so ForemanVoice
            // + pattern detection have a config to read on first boot.
            persistVoiceConfig(services.voiceConfigPath, servicesSaved);
            advance("services");
          }}
          onCancel={() => {
            persistNotifyConfigFromWizardState(services, serviceCatalog, servicesSaved);
            persistVoiceConfig(services.voiceConfigPath, servicesSaved);
            advance("services");
          }}
        />
        <Text color={theme.fg.muted}>
          [y/n] continue · [Esc] back to selection
        </Text>
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
      const onFailure = (
        failure: AgentInstallFailure,
      ): Promise<FailureResolution> => {
        setPendingFailure(failure);
        return new Promise<FailureResolution>((resolveResolution) => {
          failureResolverRef.current = resolveResolution;
        });
      };
      void runInstallStep(
        toAdd,
        toRemove,
        services,
        (line) => setInstallLog((prev) => [...prev, line]),
        agentConfigs,
        onFailure,
        { providersSelected, servicesSelected },
      ).then((summary) => {
        setInstallSummary(summary);
        advance("install");
      });
    }
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          current={4}
          total={4}
          label="Install + configure"
          phase={installRunning ? "running" : "ready"}
        />
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
        {pendingFailure && !manualFixOpen && (
          <Box
            flexDirection="column"
            marginTop={1}
            paddingX={1}
            borderStyle={singleBorder()}
            borderColor={theme.accent.danger}
          >
            <Text bold color={theme.accent.danger}>
              ✗ {pendingFailure.agentName} — {pendingFailure.stage} failed
            </Text>
            <Text color={theme.fg.muted}>{pendingFailure.error}</Text>
            <Text color={theme.fg.muted}>
              [r] retry · [s] skip this agent · [m] manual fix instructions
            </Text>
          </Box>
        )}
        {pendingFailure && manualFixOpen && (
          <Box
            flexDirection="column"
            marginTop={1}
            paddingX={1}
            borderStyle={singleBorder()}
            borderColor={theme.accent.warning}
          >
            <Text bold color={theme.accent.warning}>
              Manual fix — {pendingFailure.agentName}
            </Text>
            <Text>{pendingFailure.manualHint}</Text>
            <Text color={theme.fg.muted}>
              [Esc] back to the retry / skip prompt
            </Text>
          </Box>
        )}
        {!pendingFailure && (
          <Text color={theme.fg.muted}>
            (install running — back-navigation disabled mid-flight)
          </Text>
        )}
      </Box>
    );
  }

  // ---------------- Policy ----------------
  // ---------------- Done ----------------
  // Policy review used to be its own labelless step here; it's now reachable
  // via the Done screen's [p] hotkey (#178), so STEPS no longer carries
  // "policy" and the dedicated render block is gone (#155).
  const storedNames = new Set(
    services.secretStore.list().map((s) => s.name),
  );
  const providerIds = configuredProviderIds(providerCatalog, storedNames);
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
      {installSummary && installSummary.registered.length > 0 && (
        <LaunchCommands agentIds={installSummary.registered} />
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

export type AgentInstallStage = "install" | "config-inject" | "register";

export interface AgentInstallFailure {
  agentId: string;
  agentName: string;
  stage: AgentInstallStage;
  error: string;
  manualHint: string;
}

export type FailureResolution = "retry" | "skip" | "continue";

export type OnAgentInstallFailure = (
  failure: AgentInstallFailure,
) => Promise<FailureResolution>;

export interface InstallStepProjectionContext {
  providersSelected: string[];
  servicesSelected: string[];
}

export async function runInstallStep(
  toAdd: string[],
  toRemove: string[],
  services: WizardServices,
  log: (line: string) => void,
  agentConfigs: AgentConfigsMap = {},
  onFailure?: OnAgentInstallFailure,
  projectionCtx: InstallStepProjectionContext = {
    providersSelected: [],
    servicesSelected: [],
  },
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
      // #357 — pick uninstall command by *detected* source, not registry
      // hints, so brew-installed binaries (OpenClaw at /opt/homebrew/bin/)
      // actually get `brew uninstall` instead of a silent npm no-op.
      const detection = detectInstall(entry.install);
      const cmd = preferredUninstallCommand(entry.install, detection);
      if (cmd) {
        log(`  uninstalling (${cmd})…`);
        const result = await runUninstall({
          install: entry.install,
          detection,
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

    // Each substep is best-effort — secret-check / config-inject / identity
    // failures degrade to a warning. Binary install can pause for user
    // input via onFailure (#177); register always runs at the end.
    let skipThisAgent = false;
    while (true) {
      const detection = detectInstall(entry.install);
      if (detection.found) {
        log(`  ✓ already installed at ${detection.path}`);
        break;
      }
      const installCmd = entry.install.npm
        ? `npm install -g ${entry.install.npm}`
        : entry.install.brew
          ? `brew install ${entry.install.brew}`
          : entry.install.script
            ? `curl -fsSL ${entry.install.script} | bash`
            : null;
      if (!installCmd) break;
      log(`  installing (${installCmd})…`);
      const result = await runInstall({
        install: entry.install,
        onLine: (l) => log(`  ${l}`),
      });
      if (result.ok) break;
      log(`  ⚠ install failed (exit ${result.exitCode})`);
      log(`    run manually: ${result.manualCommand}`);
      if (!onFailure) break;
      const resolution = await onFailure({
        agentId: id,
        agentName: entry.name,
        stage: "install",
        error: `install command exited with code ${result.exitCode}`,
        manualHint: `Run \`${result.manualCommand}\` from your shell, then re-run \`foreman setup --resume\` to pick up where you left off.`,
      });
      if (resolution === "retry") {
        log(`  ↻ retrying…`);
        continue;
      }
      if (resolution === "skip") {
        log(`  ✗ skipped by user`);
        summary.failed.push(id);
        skipThisAgent = true;
      }
      break;
    }
    if (skipThisAgent) continue;

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
        } else if (plan.replacedStale) {
          applyInjection(configPath, plan);
          log(`  ⟳ replaced stale foreman entry at ${configPath}`);
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

    // Secret projection (#222 / #223) — write Foreman-stored keys to the
    // agent's own env/config files so it launches without a separate setup
    // step. Best-effort: any failure is a warning, not an install abort.
    try {
      const projection = projectSecretsForAgent(entry, {
        providersSelected: projectionCtx.providersSelected,
        servicesSelected: projectionCtx.servicesSelected,
        secretStore: services.secretStore,
      });
      for (const f of projection.files) {
        const tag = f.replacedStale ? "⟳ rotated" : f.created ? "✓ wrote" : "✓ updated";
        log(`  ${tag} ${f.secrets.length} secret${f.secrets.length === 1 ? "" : "s"} → ${f.path}`);
      }
      for (const s of projection.skipped) {
        log(`  ◦ skip projection of ${s.secret}: ${s.reason}`);
      }
    } catch (err) {
      log(
        `  ⚠ secret projection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // #350 — provider-config conflict check. Many agents have `provider:`
    // baked into their own config from a previous setup; that value wins
    // over the env vars we just projected. Warn loudly with a fix command
    // so the user doesn't think Foreman is silently broken.
    try {
      const foremanProvider = agentConfigs[id]?.llmProvider;
      if (foremanProvider) {
        const conflict = detectProviderConflict(entry, foremanProvider);
        if (conflict) {
          log(`  ⚠ provider mismatch — Foreman's key won't be used:`);
          for (const line of formatConflictWarning(conflict)) {
            log(`     ${line}`);
          }
        }
      }
    } catch {
      /* best-effort — malformed config files shouldn't block install */
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
      // Some agents (Hermes) keep their own MCP server registry CLI-side
      // and don't read the YAML block we injected. Surface the extra step
      // here so the user sees it in the right context (#298).
      const registerHint = buildMcpRegisterHint(id, entry);
      if (registerHint) {
        log(`  ℹ ${entry.name} needs one extra step to route through Foreman:`);
        if (registerHint.note) log(`     ${registerHint.note}`);
        // #346 — write the wrapper script for agents (Hermes) that can't
        // accept multi-token --args. The command above already points at
        // wrapper.path via {wrapper_path} substitution.
        if (registerHint.wrapper) {
          try {
            const wrote = writeMcpWrapperScript(registerHint.wrapper);
            log(
              `     ${wrote ? "✓ wrote" : "✓ wrapper present"} ${registerHint.wrapper.path}`,
            );
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            log(`     ⚠ wrapper write failed: ${reason}`);
          }
        }
        log(`     $ ${registerHint.command}`);
        if (registerHint.verify) {
          log(`     verify with: ${registerHint.verify}`);
        }
      }
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

// Done-screen tile that lists how to start each newly-installed agent. Driven
// by `secret_projection.launch` in the registry — single string OR array of
// {command, label} (Hermes chat vs gateway, OpenClaw chat vs gateway).
function LaunchCommands({ agentIds }: { agentIds: string[] }): JSX.Element | null {
  const { doc } = loadActiveRegistry();
  const rows = agentIds
    .map((id) => safeFind(doc, id))
    .filter((e): e is AgentEntry => e !== null)
    .filter((e) => e.secret_projection?.launch !== undefined);
  if (rows.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Launch your agents</Text>
      {rows.map((entry) => {
        const launch = entry.secret_projection!.launch!;
        const commands = typeof launch === "string"
          ? [{ command: launch, label: "" }]
          : launch;
        return (
          <Box flexDirection="column" key={entry.id} marginLeft={2}>
            <Text>
              <Text color={theme.accent.primary}>▸ {entry.name}</Text>
            </Text>
            {commands.map((c, i) => (
              <Text key={`${entry.id}-${i}`}>
                {"    "}
                <Text color={theme.accent.primary}>{c.command}</Text>
                {c.label ? (
                  <Text color={theme.fg.muted}>{`  (${c.label})`}</Text>
                ) : null}
              </Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
