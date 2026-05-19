import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
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
import { classifyInstallLog } from "./install-log-classify.js";
import {
  detectInstall,
  disableManagedLaunchAgent,
  preferredInstallCommand,
  preferredUninstallCommand,
  runInstall,
  runPostConfigCommands,
  runShell,
  runUninstall,
} from "../core/agent-install.js";
import { buildMcpSnippet } from "../core/agent-mcp-snippet.js";
import {
  autoRegisterMcp,
  buildMcpRegisterHint,
  writeMcpWrapperScript,
} from "../core/agent-mcp-register-hint.js";
import {
  findAgent,
  loadActiveProviders,
  loadActiveRegistry,
  loadActiveServices,
  resolveBundledTemplatePath,
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
import {
  bytesToGb,
  detectMachineCapability,
  type MachineCapability,
} from "../core/machine-capability.js";
import { detectOllama } from "../core/ollama-detector.js";
import {
  isRequiredSetupComplete,
  resolveRequiredSetup,
  type RequiredSetupResolution,
} from "../core/required-setup.js";
import { ChatPrimaryService } from "../core/chat-primary.js";
import { openInBrowser } from "../utils/browser-open.js";
import {
  canRunModel,
  loadOllamaModels,
  type OllamaModel,
  type RunStatus,
} from "../core/ollama-models.js";
import {
  findPreset,
  loadLlmPresets,
  type LlmPreset,
} from "../core/llm-provider-presets.js";
import {
  discoverModels,
  ModelDiscoveryError,
  type DiscoveredModel,
} from "../core/llm/models-discovery.js";
import { planOllamaInstall } from "../core/ollama-installer.js";
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

// #459 — Braille spinner frames used by the install step. 10-frame rotation
// at 80ms = 8 frames/sec — matches the snappy boot-mascot vibe.
const BRAILLE_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

// #448 — Compute a sliding window around the cursor for picker
// render blocks where the list can be longer than the visible
// region. Keeps the cursor inside [start, start+size-1] so down-
// arrow past the bottom slides the window down, not off-screen.
// Returns hidden counts so the render can show "N more above /
// below" hints. Window size kept at 12 to match the existing
// density of the model-pick picker.
export interface PickerViewport<T> {
  visible: T[];
  start: number;
  topHidden: number;
  bottomHidden: number;
}

export function computePickerViewport<T>(
  items: T[],
  cursorIdx: number,
  size: number,
): PickerViewport<T> {
  const total = items.length;
  if (total <= size) {
    return { visible: items, start: 0, topHidden: 0, bottomHidden: 0 };
  }
  const half = Math.floor(size / 2);
  let start = Math.max(0, cursorIdx - half);
  if (start + size > total) start = total - size;
  if (start < 0) start = 0;
  return {
    visible: items.slice(start, start + size),
    start,
    topHidden: start,
    bottomHidden: total - (start + size),
  };
}

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
  { number: 2, name: "Foreman's brain", estimateMinutes: 1 },
  { number: 3, name: "Agents", estimateMinutes: 2 },
  { number: 4, name: "Services", estimateMinutes: 1, optional: true },
  { number: 5, name: "Install + Verify", estimateMinutes: 3 },
];

export function totalEstimatedMinutes(
  steps: readonly WelcomeStep[] = WELCOME_STEPS,
): number {
  return steps.reduce((sum, s) => sum + s.estimateMinutes, 0);
}

// Format the trailing tag for an Ollama model row in the wizard's picker.
// `[recommended]` / `[balanced]` / `[tight — N%]` for enabled rows;
// `[installed]` appended when the model is already pulled locally.
export function formatOllamaRunTag(
  model: OllamaModel,
  status: RunStatus,
  installedModels: readonly string[],
): string {
  const installed = installedModels.includes(model.name);
  const parts: string[] = [];
  if (status.state === "recommended") {
    if (model.recommended) parts.push("[recommended]");
  } else if (status.state === "balanced") {
    parts.push("[balanced]");
  } else if (status.state === "tight") {
    parts.push(`[tight — ${status.ramPct}% RAM]`);
  }
  if (installed) parts.push("[installed]");
  return parts.length > 0 ? "  " + parts.join(" ") : "";
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
  /** #426 — Primary chat agent per messaging channel. Wizard's
   *  chat-primary step writes here; the projector reads it via the
   *  ProjectionContext. Wizard caller is responsible for instantiating
   *  + passing this; defaults to a no-op service when omitted (legacy). */
  chatPrimary?: ChatPrimaryService;
  policyPath: string;
  /** Path to llm.yaml — wizard writes here after providers step (#289). */
  llmConfigPath: string;
  /** Path to notify.yaml — wizard writes here after services step (#290). */
  notifyConfigPath: string;
  /** Path to voice.yaml — wizard seeds here after services step (#305).
   *  ForemanVoice + PatternDetectionService read from this on startup. */
  voiceConfigPath: string;
  launchEditor: (path: string) => Promise<unknown>;
  /** #468 — When the Done screen's [y] hotkey is pressed, the wizard
   *  exits and hands off these OAuth/interactive_setup commands to the
   *  outer CLI for inline browser-flow execution. The CLI spawns them
   *  with inherited stdio so the user's browser actually opens. */
  requestOauthRun?: (steps: WizardOauthRunStep[]) => void;
}

export interface WizardOauthRunStep {
  agentId: string;
  command: string;
  verify: string | null;
  mandatory: boolean;
  reason: string | null;
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

// #367 — Foreman's-LLM step sub-phases. `picker` is the universal choice;
// `ollama-*` and `preset-*` are sub-flows the user enters from the picker.
export type ForemanLlmPhase =
  | "picker"
  | "cloud-model"
  | "ollama-not-installed"
  | "ollama-model"
  | "preset-pick"
  | "preset-key";

// Stable ids for the universal picker rows. Cloud ids match provider
// catalog ids; `ollama`, `preset`, `skip` are wizard-level sentinels.
export type ForemanLlmChoice =
  | "anthropic"
  | "openai"
  | "gemini"
  | "ollama"
  | "preset"
  | "skip";

// #434 — `model-pick` inserts a step between llm-choice + responsibility-
// note: after the user picks the provider, we fetch the live model list
// for that provider's key and let them pick a specific version (e.g.
// gpt-5-mini, claude-opus-4-7). Skipping falls back to the variant default.
// #450 — `variant-pick` inserts a step between llm-choice + model-pick
// when the agent has multiple variants for the chosen provider (e.g.
// Hermes/openai: via-openrouter vs via-codex-oauth). Runtime auto-skips
// when only one variant exists.
export type AgentConfigPromptKind =
  | "llm-choice"
  | "variant-pick"
  | "model-pick"
  | "responsibility-note";

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
    // #450 — Variant pick. Agent's provider_mapping may declare
    // multiple ways to reach a single provider (e.g. Hermes/openai:
    // via-openrouter vs via-codex-oauth). When the picked provider
    // has >1 variants we need to ask the user. Runtime auto-skips
    // when single-variant; we emit the prompt unconditionally for
    // any agent with provider_mapping so the picked-provider check
    // can happen with the chosen llmProvider in hand.
    if (a.provider_mapping && choosable.length >= 1) {
      prompts.push({ agentId: id, kind: "variant-pick" });
    }
    // #434 — Every agent with a chooseable provider also gets a
    // model-pick prompt. Single-provider agents (Claude Code,
    // Codex on api-key, ZeroClaw) still get one — the picker uses
    // the single available provider implicitly. Discovery happens
    // at render time; the prompt structure stays cheap to compute.
    if (choosable.length >= 1) {
      prompts.push({ agentId: id, kind: "model-pick" });
    }
    prompts.push({ agentId: id, kind: "responsibility-note" });
  }
  return prompts;
}

/**
 * #471 — For each agent currently in the per-agent-config queue, return
 * the implicit llmProvider when (a) cfg.llmProvider isn't already set AND
 * (b) the agent has exactly one compatible provider. Returns `{}` when
 * there's nothing to seed — the caller can short-circuit the setState.
 *
 * Single-compat agents (Codex/openai-only, Claude Code/anthropic-only) used
 * to register with `llm_provider: NULL` because the llm-choice picker
 * skipped them and no other phase persisted the implicit choice. The
 * resolver then dropped them out of required-setup, identity pushes
 * silently failed, and the Done screen showed misleading "X of N agents".
 */
export function computeSingleCompatProviderSeeds(
  prompts: AgentConfigPrompt[],
  agentConfigs: Record<string, { llmProvider?: string } | undefined>,
  agentCatalog: AgentEntry[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const prompt of prompts) {
    if (seen.has(prompt.agentId)) continue;
    seen.add(prompt.agentId);
    if (agentConfigs[prompt.agentId]?.llmProvider) continue;
    const agentEntry = agentCatalog.find((a) => a.id === prompt.agentId);
    const compat = agentEntry?.llm_compat ?? [];
    if (compat.length !== 1) continue;
    out[prompt.agentId] = compat[0]!;
  }
  return out;
}

/**
 * #audit-finding-6 — Map ModelDiscoveryError's raw HTTP wording into an
 * actionable hint the user can act on without leaving the wizard. Auth
 * failures (401/403) point back at Step 1 because the key is the most
 * likely cause; rate limits and 5xx say "try again later" rather than
 * sending the user on a key-rotation chase.
 */
export function classifyModelDiscoveryError(
  rawMessage: string,
  provider: string,
): string {
  const statusMatch = rawMessage.match(/^HTTP (\d{3})/);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  if (status === 401 || status === 403) {
    return (
      `${provider} rejected the API key (HTTP ${status}). Press [Esc] to go ` +
      `back to Step 1 (Providers) and rotate ${provider}-key, or skip to use the ` +
      `registry default model.`
    );
  }
  if (status === 429) {
    return (
      `${provider} is rate-limiting model discovery (HTTP 429). Wait a minute ` +
      `and retry, or skip to use the registry default model.`
    );
  }
  if (status && status >= 500) {
    return (
      `${provider} returned a server error (HTTP ${status}). This is usually ` +
      `transient — retry in a moment, or skip to use the registry default.`
    );
  }
  if (/abort|timeout|network|fetch failed/i.test(rawMessage)) {
    return (
      `Couldn't reach ${provider} to list models — check your internet ` +
      `connection, or skip to use the registry default model.`
    );
  }
  return rawMessage;
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

// #367 — Persist the user's explicit Foreman-LLM choice from the new
// Step 2. Sets `provider` + `model` to the picked path, flips
// `features.verification + smart_report` on (off when user picked
// "Skip"), and wires preset credentials into `credentials.openai_compatible`.
// For preset choices, also writes the user's API key to the secret store.
function persistForemanLlmChoice(args: {
  services: WizardServices;
  choice: ForemanLlmChoice;
  ollamaModel: string | null;
  preset: LlmPreset | null;
  presetKey: string;
  /** #399 — When set, overrides the hardcoded default for cloud choices.
   *  Bare model id (e.g. `gpt-5.4-mini`, not `openai/gpt-5.4-mini`). */
  cloudModel?: string | null;
}): void {
  try {
    const existing = loadLlmConfig(args.services.llmConfigPath);
    const next = { ...existing };

    if (args.choice === "skip") {
      next.enabled = false;
      next.features = {
        ...existing.features,
        verification: false,
        smart_report: false,
      };
      saveLlmConfig(args.services.llmConfigPath, next);
      return;
    }

    next.enabled = true;
    next.features = {
      ...existing.features,
      verification: true,
      smart_report: true,
    };

    if (args.choice === "anthropic") {
      next.provider = "anthropic";
      next.model = args.cloudModel ?? "claude-haiku-4-5-20251001";
    } else if (args.choice === "openai") {
      next.provider = "openai";
      next.model = args.cloudModel ?? "gpt-4o-mini";
    } else if (args.choice === "gemini") {
      next.provider = "gemini";
      next.model = args.cloudModel ?? "gemini-2.0-flash";
    } else if (args.choice === "ollama" && args.ollamaModel) {
      next.provider = "ollama";
      next.model = args.ollamaModel;
      next.credentials = {
        ...existing.credentials,
        ollama: {
          ...(existing.credentials.ollama ?? {}),
          endpoint: existing.credentials.ollama?.endpoint ??
            "http://localhost:11434",
          secret_name: null,
        },
      };
    } else if (args.choice === "preset" && args.preset) {
      next.provider = "openai_compatible";
      next.model = args.preset.default_model;
      next.credentials = {
        ...existing.credentials,
        openai_compatible: {
          endpoint_secret: `${args.preset.id}-endpoint`,
          key_secret: args.preset.key_secret_name,
        },
      };
      // Save the API key + endpoint URL to the secret store so the
      // openai_compatible client can resolve them at call time. Use
      // rotate when the secret already exists (user re-runs the wizard).
      const upsertSecret = (name: string, value: string): void => {
        try {
          args.services.secretStore.add(name, value);
        } catch {
          try {
            args.services.secretStore.rotate(name, value);
          } catch (err) {
            console.error(
              `⚠ failed to save secret ${name}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      };
      upsertSecret(args.preset.key_secret_name, args.presetKey);
      upsertSecret(`${args.preset.id}-endpoint`, args.preset.endpoint);
    }

    saveLlmConfig(args.services.llmConfigPath, next);
  } catch (err) {
    console.error(
      `⚠ failed to persist Foreman-LLM choice: ${err instanceof Error ? err.message : String(err)}`,
    );
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

  // #367 — Foreman's own LLM (verifier + smart summary). The wizard's new
  // Step 2 makes this an explicit choice instead of silently picking the
  // first configured provider from Step 1.
  const [foremanLlmPhase, setForemanLlmPhase] = useState<ForemanLlmPhase>(
    "picker",
  );
  const [foremanLlmDraft, setForemanLlmDraft] = useState<string | null>(null);
  // #399 — live model picker. After the user picks a cloud provider, we
  // fetch the actual available models for their key and let them choose.
  // Loading → null options + null error. Error → null options + error msg.
  // Success → options array, error null. Draft is the bare model id.
  const [cloudModelProvider, setCloudModelProvider] = useState<
    "openai" | "anthropic" | "gemini" | null
  >(null);
  const [cloudModelOptions, setCloudModelOptions] = useState<
    DiscoveredModel[] | null
  >(null);
  const [cloudModelError, setCloudModelError] = useState<string | null>(null);
  const [cloudModelDraft, setCloudModelDraft] = useState<string | null>(null);
  const [ollamaModelDraft, setOllamaModelDraft] = useState<string | null>(null);
  const [presetDraft, setPresetDraft] = useState<string | null>(null);
  const [presetKeyDraft, setPresetKeyDraft] = useState<string>("");

  // #434 — Per-agent model picker state. `agentModelOptions` is the
  // live-discovered model list for the active prompt's provider;
  // `agentModelDraft` is the highlighted choice. Both reset when the
  // prompt index changes (effect below). Loading = options===null,
  // error = options===[] + error set.
  const [agentModelOptions, setAgentModelOptions] = useState<
    DiscoveredModel[] | null
  >(null);
  const [agentModelError, setAgentModelError] = useState<string | null>(null);
  const [agentModelDraft, setAgentModelDraft] = useState<string | null>(null);

  // #450 — Per-agent variant picker draft. Holds the highlighted
  // variant id for the active model-pick prompt; persisted into
  // agentConfigs[id].providerVariant on commit.
  const [agentVariantDraft, setAgentVariantDraft] = useState<string | null>(
    null,
  );

  // #457 — When the preferred variant needs no extra credentials, the
  // variant picker auto-skips and records the choice here so the
  // required-setup screen can flash a "Foreman picked the X route — switch
  // later with `foreman provider switch ...`" notice. Map: agentId → variant
  // label.
  const [autoPickedVariants, setAutoPickedVariants] = useState<
    Record<string, { variantId: string; label: string }>
  >({});

  // #408 / #411 Phase 3 — required-setup step state.
  // The wizard precomputes a `RequiredSetupResolution` (which agents need
  // which secrets, which OAuth flows queue up). User can paste missing
  // keys or [s]kip them; skipped + missing secrets will block install
  // until handled.
  const [requiredSetupPhase, setRequiredSetupPhase] = useState<
    "picker" | "paste"
  >("picker");
  const [requiredSetupCursor, setRequiredSetupCursor] = useState(0);
  const [requiredSetupPasteValue, setRequiredSetupPasteValue] = useState("");
  const [requiredSetupOverrides, setRequiredSetupOverrides] = useState<
    Record<string, "saved-in-session" | "skipped">
  >({});
  const machineCap = useMemo<MachineCapability>(
    () => detectMachineCapability(),
    [],
  );
  const ollamaModelDoc = useMemo(() => loadOllamaModels(), []);
  const llmPresetDoc = useMemo(() => loadLlmPresets(), []);
  // Re-detect Ollama whenever we hit a foreman-llm phase that needs it —
  // user might have run `brew install ollama` in another terminal between
  // wizard renders.
  const ollamaDetection = useMemo(
    () => detectOllama(),
    [foremanLlmPhase, currentStep],
  );

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

  // #408 / #411 Phase 3 — required-setup resolution.
  // Recomputed on every render so paste/skip actions reflect immediately.
  // The aggregator dedupes secrets across agents (one paste prompt
  // covers multiple agents sharing the same key slot) and queues OAuth
  // flows that the Done screen surfaces as post-install hints.
  const requiredSetupResolution = useMemo<RequiredSetupResolution>(() => {
    const selectedEntries = agentCatalog.filter((a) =>
      agentsSelected.includes(a.id),
    );
    const agentProviders: Record<string, string> = {};
    const agentVariants: Record<string, string> = {};
    for (const agent of selectedEntries) {
      const cfg = agentConfigs[agent.id];
      if (cfg?.llmProvider) {
        agentProviders[agent.id] = cfg.llmProvider;
      }
      if (cfg?.providerVariant) {
        agentVariants[agent.id] = cfg.providerVariant;
      }
    }
    return resolveRequiredSetup({
      agents: selectedEntries,
      agentProviders,
      agentVariants,
      secretStore: services.secretStore,
      sessionOverrides: requiredSetupOverrides,
    });
  }, [
    agentCatalog,
    agentsSelected,
    agentConfigs,
    services.secretStore,
    requiredSetupOverrides,
  ]);

  const serviceCatalog = useMemo(() => loadActiveServices().doc.services, []);
  const [servicesSelected, setServicesSelected] = useState<string[]>([]);
  const [serviceIdx, setServiceIdx] = useState(0);
  const [servicesPhase, setServicesPhase] = useState<ServicesPhase>("picker");
  const [servicesSaved, setServicesSaved] = useState<string[]>([]);
  const [servicesSkipped, setServicesSkipped] = useState<string[]>([]);
  const [servicesWarning, setServicesWarning] = useState<string | null>(null);

  // #426 — Primary chat agent picker state. `chatPrimaryChannelsNeeded`
  // lists messaging channels (telegram/discord/slack) where 2+ selected
  // chat_capable agents both support the same channel — those are the
  // collisions the wizard must resolve. Empty → step auto-skipped.
  const chatPrimaryChannelsNeeded = useMemo<
    Array<{ channel: string; candidates: AgentEntry[] }>
  >(() => {
    const messagingChannels = ["telegram", "discord", "slack"];
    const out: Array<{ channel: string; candidates: AgentEntry[] }> = [];
    for (const ch of messagingChannels) {
      if (!servicesSelected.includes(ch)) continue;
      const cands = agentCatalog.filter(
        (a) =>
          agentsSelected.includes(a.id) &&
          a.chat_capable === true &&
          (a.optional_services ?? []).includes(ch),
      );
      if (cands.length >= 2) out.push({ channel: ch, candidates: cands });
    }
    return out;
  }, [servicesSelected, agentsSelected, agentCatalog]);
  const [chatPrimaryChannelIdx, setChatPrimaryChannelIdx] = useState(0);
  const [chatPrimaryCursor, setChatPrimaryCursor] = useState(0);
  const [chatPrimaryDrafts, setChatPrimaryDrafts] = useState<
    Record<string, string>
  >({});

  // Auto-advance past chat-primary when there's no collision to resolve
  // (zero or one chat_capable agent, or no messaging channel). Without
  // this, the wizard would land on a blank picker.
  useEffect(() => {
    if (
      currentStep === "chat-primary" &&
      chatPrimaryChannelsNeeded.length === 0
    ) {
      advance("chat-primary");
    }
  }, [currentStep, chatPrimaryChannelsNeeded.length]);

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

  const [installLog, setInstallLog] = useState<string[]>([]);
  const [installRunning, setInstallRunning] = useState(false);
  const [installSummary, setInstallSummary] =
    useState<InstallStepSummary | null>(null);
  const [pendingFailure, setPendingFailure] =
    useState<AgentInstallFailure | null>(null);
  // #459 — Install UX. The render path collapses raw upstream installer
  // output into a single spinner + milestone line; this state powers the
  // spinner animation and elapsed-time display. `installStartedAt` is set
  // when the install actually fires, not at component mount, so the timer
  // matches what the user sees.
  const [installStartedAt, setInstallStartedAt] = useState<number | null>(null);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  useEffect(() => {
    if (!installRunning || installSummary || !installStartedAt) return;
    const interval = setInterval(() => {
      setSpinnerFrame((f) => f + 1);
    }, 80);
    return () => clearInterval(interval);
  }, [installRunning, installSummary, installStartedAt]);
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
    // #367 — Foreman's-LLM step key handling. Each phase has its own
    // ↑↓ cursor + Space/Enter commit + Esc back-out.
    if (currentStep === "foreman-llm") {
      const storedNames = new Set(
        services.secretStore.list().map((s) => s.name),
      );
      const configured = new Set(
        configuredProviderIds(providerCatalog, storedNames),
      );

      // ----- picker phase -----
      if (foremanLlmPhase === "picker") {
        // #370 — Disabled cloud rows are rendered but skipped here so
        // ↑↓ nav cycles only the actionable rows; Enter on a disabled
        // row is a no-op (the warning hint is rendered separately).
        const visible: ForemanLlmChoice[] = [];
        if (configured.has("anthropic")) visible.push("anthropic");
        if (configured.has("openai")) visible.push("openai");
        if (configured.has("gemini")) visible.push("gemini");
        visible.push("ollama", "preset", "skip");
        const cursor =
          (foremanLlmDraft as ForemanLlmChoice | null) ?? visible[0] ?? "skip";
        const idx = Math.max(0, visible.indexOf(cursor));
        if (key.upArrow) {
          setForemanLlmDraft(
            visible[(idx - 1 + visible.length) % visible.length] ?? null,
          );
          return;
        }
        if (key.downArrow) {
          setForemanLlmDraft(visible[(idx + 1) % visible.length] ?? null);
          return;
        }
        if (key.escape) {
          // Send the user back to providers — uncompleted providers state
          // re-renders Step 1 with their current saves.
          uncomplete("providers");
          return;
        }
        if (key.return || input === " ") {
          const chosen = cursor;
          if (chosen === "ollama") {
            if (!ollamaDetection.installed) {
              setForemanLlmPhase("ollama-not-installed");
            } else {
              setForemanLlmPhase("ollama-model");
            }
            return;
          }
          if (chosen === "preset") {
            setForemanLlmPhase("preset-pick");
            return;
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
            setCloudModelDraft(null);
            setForemanLlmPhase("cloud-model");
            // Kick off async fetch — wizard renders the loading state in
            // the meantime. We don't await here: useInput must stay
            // synchronous, and the discovery cache means re-entries are
            // cheap.
            void (async (): Promise<void> => {
              const keySecret = `${chosen}-key`;
              try {
                const apiKey = services.secretStore.exists(keySecret)
                  ? services.secretStore.get(keySecret)
                  : null;
                if (!apiKey) {
                  setCloudModelError(
                    `No ${chosen}-key in the secret store — go back, set it in Step 1, then return here.`,
                  );
                  setCloudModelOptions([]);
                  return;
                }
                const models = await discoverModels(chosen, { apiKey });
                if (models.length === 0) {
                  setCloudModelError(
                    `${chosen} returned no chat-capable models for this key.`,
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
                setCloudModelError(msg);
                setCloudModelOptions([]);
              }
            })();
            return;
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
          return;
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
          setCloudModelDraft(null);
          return;
        }
        // While loading there's nothing actionable except Esc.
        if (cloudModelOptions === null) return;
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
            setCloudModelDraft(null);
            setForemanLlmDraft(null);
            advance("foreman-llm");
          }
          return;
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
          return;
        }
        if (key.downArrow) {
          const len = cloudModelOptions.length;
          const next = cloudModelOptions[(safeIdx + 1) % len]?.id ?? null;
          setCloudModelDraft(next);
          return;
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
          setCloudModelDraft(null);
          setForemanLlmDraft(null);
          advance("foreman-llm");
          return;
        }
      }

      // ----- ollama-not-installed phase -----
      if (foremanLlmPhase === "ollama-not-installed") {
        if (key.escape) {
          setForemanLlmPhase("picker");
          return;
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
          return;
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
          return;
        }
        const cursor = ollamaModelDraft ?? enabled[0]?.name ?? "";
        const idx = Math.max(0, enabled.findIndex((m) => m.name === cursor));
        if (key.upArrow) {
          setOllamaModelDraft(
            enabled[(idx - 1 + enabled.length) % enabled.length]?.name ?? null,
          );
          return;
        }
        if (key.downArrow) {
          setOllamaModelDraft(
            enabled[(idx + 1) % enabled.length]?.name ?? null,
          );
          return;
        }
        if (key.escape) {
          setForemanLlmPhase("picker");
          return;
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
          return;
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
          return;
        }
        if (key.downArrow) {
          setPresetDraft(presets[(idx + 1) % presets.length]?.id ?? null);
          return;
        }
        if (key.escape) {
          setForemanLlmPhase("picker");
          return;
        }
        if (key.return || input === " ") {
          const chosen = presets[idx];
          if (chosen) {
            setPresetDraft(chosen.id);
            setForemanLlmPhase("preset-key");
          }
          return;
        }
      }

      // preset-key — handled by the PasswordInput's onSubmit. Esc back-out:
      if (foremanLlmPhase === "preset-key") {
        if (key.escape) {
          setForemanLlmPhase("preset-pick");
          setPresetKeyDraft("");
          return;
        }
      }
    }

    // #434 — Per-agent model picker key handling. Shows up between
    // llm-choice and responsibility-note. ↑↓ moves cursor through the
    // discovered models, Enter commits, [s] skips (uses variant default).
    // #450 — Variant picker handler. Lists variants of the picked
    // provider's mapping (e.g. Hermes/openai: via-openrouter vs
    // via-codex-oauth). Auto-skip happens in the useEffect when
    // single-variant; this handler only runs when multi-variant.
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
        if (!effectiveProvider || !agentEntry?.provider_mapping) return;
        const providerMapping = agentEntry.provider_mapping[effectiveProvider];
        if (!providerMapping) return;
        const variantIds = Object.keys(providerMapping.variants);
        if (variantIds.length <= 1) return;
        const cursor = agentVariantDraft ?? providerMapping.preferred;
        const idx = Math.max(0, variantIds.indexOf(cursor));
        if (key.upArrow) {
          setAgentVariantDraft(
            variantIds[(idx - 1 + variantIds.length) % variantIds.length] ??
              null,
          );
          return;
        }
        if (key.downArrow) {
          setAgentVariantDraft(
            variantIds[(idx + 1) % variantIds.length] ?? null,
          );
          return;
        }
        if (key.escape) {
          // Step back to llm-choice for this agent.
          setAgentConfigIdx(Math.max(0, agentConfigIdx - 1));
          setAgentVariantDraft(null);
          return;
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
          return;
        }
        return;
      }
    }

    if (
      currentStep === "agents" &&
      agentsPhase === "per-agent-config"
    ) {
      const prompt = agentConfigPrompts[agentConfigIdx];
      if (prompt && prompt.kind === "model-pick") {
        // Loading: only Esc/s actionable.
        if (agentModelOptions === null) {
          if (key.escape || input === "s" || input === "S") {
            // Skip → advance without storing modelVersion (= variant default).
            const result = applyAgentConfigSubmit({
              currentIdx: agentConfigIdx,
              totalPrompts: agentConfigPrompts.length,
            });
            setAgentConfigIdx(result.nextIdx);
            setAgentsPhase(result.nextPhase);
            return;
          }
          return;
        }
        // Error / empty list: only [s]kip or [Enter] (accepted as skip)
        // advances. Esc goes back to the llm-choice for the same agent.
        if (agentModelOptions.length === 0) {
          if (key.escape) {
            // Step back to llm-choice for THIS agent (it's the prompt
            // immediately before model-pick in the list).
            setAgentConfigIdx(Math.max(0, agentConfigIdx - 1));
            return;
          }
          if (key.return || input === "s" || input === "S") {
            const result = applyAgentConfigSubmit({
              currentIdx: agentConfigIdx,
              totalPrompts: agentConfigPrompts.length,
            });
            setAgentConfigIdx(result.nextIdx);
            setAgentsPhase(result.nextPhase);
            return;
          }
          return;
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
          return;
        }
        if (key.downArrow) {
          const len = agentModelOptions.length;
          setAgentModelDraft(agentModelOptions[(safeIdx + 1) % len]?.id ?? null);
          return;
        }
        if (key.escape) {
          setAgentConfigIdx(Math.max(0, agentConfigIdx - 1));
          return;
        }
        if (input === "s" || input === "S") {
          // Skip → no modelVersion stored; variant default applies.
          const result = applyAgentConfigSubmit({
            currentIdx: agentConfigIdx,
            totalPrompts: agentConfigPrompts.length,
          });
          setAgentConfigIdx(result.nextIdx);
          setAgentsPhase(result.nextPhase);
          return;
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
          return;
        }
      }
    }

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

    // #408 / #411 Phase 3 — required-setup step key handling.
    // Two phases: picker (cursor over secrets+oauth list) + paste (single-line
    // input for the focused secret). Aggregator output (`requiredSetupResolution`)
    // is recomputed on every keystroke so paste/skip reactions are immediate.
    if (currentStep === "required-setup") {
      if (requiredSetupPhase === "paste") {
        if (key.escape) {
          setRequiredSetupPhase("picker");
          setRequiredSetupPasteValue("");
          return;
        }
        if (key.return) {
          // Save the pasted value into the secret store + flag this slot
          // as saved-in-session so the aggregator stops flagging it.
          const slot =
            requiredSetupResolution.secrets[requiredSetupCursor]?.slotName;
          if (slot && requiredSetupPasteValue.length > 0) {
            try {
              if (services.secretStore.exists(slot)) {
                services.secretStore.rotate(slot, requiredSetupPasteValue);
              } else {
                services.secretStore.add(slot, requiredSetupPasteValue);
              }
            } catch {
              /* secret-store transient errors fall through — user sees
                 a missing badge and can retry */
            }
            setRequiredSetupOverrides((prev) => ({
              ...prev,
              [slot]: "saved-in-session",
            }));
          }
          setRequiredSetupPasteValue("");
          setRequiredSetupPhase("picker");
          return;
        }
        if (key.backspace || key.delete) {
          setRequiredSetupPasteValue((v) => v.slice(0, -1));
          return;
        }
        if (input && input.length > 0 && !key.ctrl && !key.meta) {
          setRequiredSetupPasteValue((v) => v + input);
        }
        return;
      }
      // ---- picker phase ----
      if (key.escape) {
        // Step back. If chat-primary had a collision to resolve, that's
        // the single step before us; otherwise jump past it to services
        // (chat-primary's auto-advance effect re-fires immediately).
        if (chatPrimaryChannelsNeeded.length > 0) {
          uncomplete("chat-primary");
          setChatPrimaryChannelIdx(
            Math.max(0, chatPrimaryChannelsNeeded.length - 1),
          );
          setChatPrimaryCursor(0);
          return;
        }
        uncomplete("services");
        setServicesPhase("summary");
        return;
      }
      if (key.upArrow) {
        setRequiredSetupCursor((c) =>
          Math.max(0, c - 1),
        );
        return;
      }
      if (key.downArrow) {
        setRequiredSetupCursor((c) =>
          Math.min(requiredSetupResolution.secrets.length - 1, c + 1),
        );
        return;
      }
      if (key.return) {
        // If picker has a focused secret in `missing` state → open paste.
        // If everything is resolved → advance to install.
        const cur = requiredSetupResolution.secrets[requiredSetupCursor];
        if (
          cur &&
          (cur.status === "missing" || cur.status === "skipped")
        ) {
          setRequiredSetupPhase("paste");
          return;
        }
        // No actionable row — try to advance if complete.
        if (isRequiredSetupComplete(requiredSetupResolution)) {
          advance("required-setup");
        }
        return;
      }
      if (input === "s") {
        // Skip the currently focused secret. Install will still write
        // everything else; the agent that needed this secret will fail
        // at start time with a clear error (TUI crash banner).
        const slot =
          requiredSetupResolution.secrets[requiredSetupCursor]?.slotName;
        if (slot) {
          setRequiredSetupOverrides((prev) => ({
            ...prev,
            [slot]: "skipped",
          }));
        }
        return;
      }
      if (input === "o") {
        // #408 / #413 Phase 5 — open the acquisition URL in the user's
        // default browser. Best-effort: if the platform handler fails,
        // silently no-op (user can still copy-paste from the picker
        // text). React state mirror not needed — the URL is static.
        const acq =
          requiredSetupResolution.secrets[requiredSetupCursor]?.acquisition;
        if (acq?.url) {
          void openInBrowser(acq.url).catch(() => {
            /* swallowed — fall back to manual copy */
          });
        }
        return;
      }
      if (input === "c") {
        // Continue / install — only fires when nothing is `missing`.
        if (isRequiredSetupComplete(requiredSetupResolution)) {
          advance("required-setup");
        }
        return;
      }
      return;
    }

    // #426 — Primary chat agent picker.
    if (currentStep === "chat-primary") {
      const ch = chatPrimaryChannelsNeeded[chatPrimaryChannelIdx];
      if (!ch) return;
      if (key.upArrow) {
        setChatPrimaryCursor(
          (c) => (c - 1 + ch.candidates.length) % ch.candidates.length,
        );
        return;
      }
      if (key.downArrow) {
        setChatPrimaryCursor((c) => (c + 1) % ch.candidates.length);
        return;
      }
      if (key.return || input === " ") {
        const picked = ch.candidates[chatPrimaryCursor];
        if (!picked) return;
        const nextDrafts = {
          ...chatPrimaryDrafts,
          [ch.channel]: picked.id,
        };
        setChatPrimaryDrafts(nextDrafts);
        if (chatPrimaryChannelIdx + 1 < chatPrimaryChannelsNeeded.length) {
          setChatPrimaryChannelIdx((i) => i + 1);
          setChatPrimaryCursor(0);
          return;
        }
        // Last channel — persist all picks and advance.
        if (services.chatPrimary) {
          for (const [channel, agentId] of Object.entries(nextDrafts)) {
            services.chatPrimary.set(channel, agentId);
          }
        }
        advance("chat-primary");
        return;
      }
      if (key.escape) {
        if (chatPrimaryChannelIdx > 0) {
          setChatPrimaryChannelIdx((i) => i - 1);
          setChatPrimaryCursor(0);
          return;
        }
        uncomplete("services");
        setServicesPhase("summary");
        return;
      }
      return;
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
      // #468 — Hand off the queued OAuth/interactive_setup commands to
      // the outer CLI which runs them with inherited stdio so the
      // browser-OAuth flow actually works. Exit cleanly afterwards;
      // re-running `foreman doctor` confirms the final state.
      if (input === "y" && requiredSetupResolution.oauthSteps.length > 0) {
        const steps: WizardOauthRunStep[] =
          requiredSetupResolution.oauthSteps.map((s) => ({
            agentId: s.agentId,
            command: s.command,
            verify: s.verify,
            mandatory: s.mandatory,
            reason: s.reason,
          }));
        services.requestOauthRun?.(steps);
        exit();
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
      currentStep === "done" &&
      (donePhase === "doctor" || donePhase === "log")
    ) {
      // #381 — accept multiple back keys so the user isn't stuck if Esc
      // misfires (some terminals translate Esc to multi-byte sequences
      // that Ink doesn't surface as key.escape). Round-3 user got trapped
      // on the doctor sub-page until they ^C the wizard.
      if (key.escape || key.return || input === "b" || input === "q") {
        setDonePhase("main");
        return;
      }
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
          Foreman wires multiple AI agents (Hermes, Codex, Claude Code…)
          into a Telegram bot you control. It routes messages between
          agents, guards their tool calls, and gives you a single audit
          trail.
        </Text>
        <Text color={theme.fg.muted}>
          You'll paste LLM provider keys, pick agents to install, and
          optionally set up Foreman's own AI brain for smarter routing.
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

  // ---------------- Foreman's brain (#367) ----------------
  if (currentStep === "foreman-llm") {
    const storedNames = new Set(
      services.secretStore.list().map((s) => s.name),
    );
    const configured = new Set(
      configuredProviderIds(providerCatalog, storedNames),
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
          sub: "cloud · ~$2/mo at default budget · model picked next",
          disabled: !configured.has("anthropic"),
          disabledReason: "needs Anthropic key in Step 1 — Esc to go back",
        },
        {
          value: "openai",
          label: "OpenAI",
          sub: "cloud · ~$1/mo at default budget · model picked next",
          disabled: !configured.has("openai"),
          disabledReason: "needs OpenAI key in Step 1 — Esc to go back",
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
              [s] skip (use the registry default) · [Esc] cancel
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
    // #audit-finding-9 — Telegram is the primary delivery channel; if
    // the user picked it but skipped its tokens, agents have no way to
    // reach the user post-install. Flag this loudly so they don't
    // discover the broken flow only when nothing arrives in their chat.
    const telegramSkippedWithoutSave =
      servicesSelected.includes("telegram") &&
      !servicesSaved.some((n) => n.startsWith("telegram-"));
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
        {telegramSkippedWithoutSave ? (
          <Box flexDirection="column">
            <Text color={theme.accent.warning} bold>
              ⚠ Telegram selected but token + chat id are empty
            </Text>
            <Text color={theme.fg.muted}>
              Agents won't be able to deliver replies until you paste
              telegram-bot-token + telegram-chat-id. Hit [Esc] to go
              back, or continue and add them later via:{" "}
              <Text bold>foreman secrets add telegram-bot-token</Text>.
            </Text>
          </Box>
        ) : null}
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

  // ---------------- Primary chat agent (#426) ----------------
  // Only renders when 2+ chat_capable selected agents share a messaging
  // channel; otherwise the useEffect above advance()s past this step.
  if (currentStep === "chat-primary") {
    const ch = chatPrimaryChannelsNeeded[chatPrimaryChannelIdx];
    if (!ch) {
      return <Text color={theme.fg.muted}>…</Text>;
    }
    const channelLabel =
      ch.channel.charAt(0).toUpperCase() + ch.channel.slice(1);
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          current={4}
          total={5}
          label={`Primary ${channelLabel} agent`}
          phase={`${chatPrimaryChannelIdx + 1} of ${chatPrimaryChannelsNeeded.length}`}
        />
        <Text color={theme.fg.muted}>
          {ch.candidates.length} of your selected agents can talk on{" "}
          {channelLabel}. Only one can hold the bot session at a time —
          pick which one is your default. The others stay installed but
          won't receive {channelLabel} secrets until you switch them in
          (Settings → Chat Primary, or `foreman chat set-primary`).
        </Text>
        <Box flexDirection="column">
          {ch.candidates.map((agent, idx) => {
            const focused = idx === chatPrimaryCursor;
            return (
              <Box key={agent.id} flexDirection="row">
                <Text
                  color={focused ? theme.accent.primary : undefined}
                  bold={focused}
                >
                  {focused ? "❯ " : "  "}
                </Text>
                <Text bold={focused}>{agent.name}</Text>
                <Text color={theme.fg.muted}>
                  {"  "}·  {agent.id}
                </Text>
              </Box>
            );
          })}
        </Box>
        <Text color={theme.fg.muted}>
          [↑↓] move · [Enter] confirm · [Esc] back
        </Text>
      </Box>
    );
  }

  // ---------------- Required setup (#408 / #411 Phase 3) ----------------
  if (currentStep === "required-setup") {
    const res = requiredSetupResolution;
    const totalSecrets = res.secrets.length;
    const totalOauth = res.oauthSteps.length;
    const totalErrors = res.errors.length;
    const complete = isRequiredSetupComplete(res);

    // Paste sub-phase: focused secret gets a single-line input.
    if (requiredSetupPhase === "paste") {
      const cur = res.secrets[requiredSetupCursor];
      const masked =
        requiredSetupPasteValue.length > 0
          ? `${"•".repeat(Math.min(requiredSetupPasteValue.length, 32))}`
          : "";
      return (
        <Box flexDirection="column" gap={1} paddingY={1}>
          <WizardProgress
            current={5}
            total={5}
            label="Required setup"
            phase={`paste ${cur?.slotName ?? "key"}`}
          />
          {cur?.acquisition ? (
            <Box flexDirection="column">
              <Text color={theme.fg.muted}>
                {cur.acquisition.name}
                {cur.acquisition.url
                  ? `  ·  Get one: ${cur.acquisition.url}`
                  : ""}
              </Text>
              {cur.acquisition.note ? (
                <Text color={theme.fg.muted}>{cur.acquisition.note}</Text>
              ) : null}
            </Box>
          ) : null}
          <Box>
            <Text bold>{cur?.slotName ?? ""}: </Text>
            <Text>{masked}</Text>
            <Text color={theme.fg.muted}>{masked.length === 0 ? "_" : ""}</Text>
          </Box>
          <Text color={theme.fg.muted}>
            [Enter] save · [Esc] cancel · {requiredSetupPasteValue.length} chars
          </Text>
        </Box>
      );
    }

    // Picker sub-phase: aggregated summary + scrollable secrets list.
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          current={5}
          total={5}
          label="Required setup"
          phase={complete ? "all set" : "missing keys"}
        />
        <Text color={theme.fg.muted}>
          Foreman analyzed your agent + provider picks. Below is everything
          needed before install can proceed.
        </Text>
        {/* #457 — When the preferred provider variant needs no extra
            credentials (e.g. Codex/oauth), the variant picker auto-skipped
            and we record the choice here so the user sees what was picked
            on their behalf + how to change it later. */}
        {Object.keys(autoPickedVariants).length > 0 ? (
          <Box flexDirection="column">
            <Text bold>Auto-picked variants ({Object.keys(autoPickedVariants).length})</Text>
            {Object.entries(autoPickedVariants).map(([agentId, info]) => (
              <Box key={agentId} flexDirection="column">
                <Text color={theme.accent.primary}>
                  {"  "}✓ {agentId}: {info.label}
                </Text>
                <Text color={theme.fg.muted}>
                  {`     change later: foreman provider switch ${agentId} <provider> --variant <id>`}
                </Text>
              </Box>
            ))}
          </Box>
        ) : null}
        {totalErrors > 0 ? (
          <Box flexDirection="column">
            <Text color={theme.accent.warning} bold>
              ⚠ Resolver errors ({totalErrors}) — go back to fix
            </Text>
            {res.errors.map((e) => (
              <Text key={`${e.agentId}-${e.foremanProvider}`} color={theme.accent.warning}>
                {"  "}• {e.agentId} / {e.foremanProvider}: {e.error}
              </Text>
            ))}
          </Box>
        ) : null}
        {totalSecrets > 0 ? (
          <Box flexDirection="column">
            <Text bold>
              Required secrets ({totalSecrets})
            </Text>
            {res.secrets.map((s, idx) => {
              const focused = idx === requiredSetupCursor;
              const tag =
                s.status === "present"
                  ? "✓"
                  : s.status === "saved-in-session"
                    ? "✓"
                    : s.status === "skipped"
                      ? "✗"
                      : "⚠";
              const colour =
                s.status === "missing"
                  ? theme.accent.warning
                  : s.status === "skipped"
                    ? theme.fg.muted
                    : theme.accent.primary;
              return (
                <Box key={s.slotName} flexDirection="column">
                  <Box flexDirection="row">
                    <Text color={focused ? theme.accent.primary : undefined} bold={focused}>
                      {focused ? "❯ " : "  "}
                    </Text>
                    <Text color={colour}>{tag}</Text>
                    <Text> {s.slotName}</Text>
                    <Text color={theme.fg.muted}>
                      {"  "}for: {s.agents.join(", ")} · status: {s.status}
                    </Text>
                  </Box>
                  {focused && s.acquisition ? (
                    <>
                      <Text color={theme.fg.muted}>
                        {"     "}
                        {s.acquisition.name}
                        {s.acquisition.url
                          ? `  ·  ${s.acquisition.url}`
                          : ""}
                      </Text>
                      {/* #449 — Show the acquisition.note inline so the
                          user understands WHY this secret is being asked
                          for (e.g. "Hermes routes OpenAI calls through
                          OpenRouter — there's no native OpenAI provider..."). */}
                      {s.acquisition.note ? (
                        <Text color={theme.accent.warning}>
                          {"     "}
                          {s.acquisition.note}
                        </Text>
                      ) : null}
                    </>
                  ) : null}
                </Box>
              );
            })}
          </Box>
        ) : (
          <Text color={theme.fg.muted}>No secrets needed — every selected agent uses OAuth or is already configured.</Text>
        )}
        {totalOauth > 0 ? (
          <Box flexDirection="column">
            <Text bold>OAuth steps queued ({totalOauth})</Text>
            <Text color={theme.fg.muted}>
              These you'll run manually AFTER setup completes:
            </Text>
            {res.oauthSteps.map((o) => (
              <Box key={`${o.agentId}-${o.command}`} flexDirection="column">
                <Text color={o.mandatory ? theme.accent.warning : theme.fg.muted}>
                  {"  "}
                  {o.mandatory ? "⚠ MUST: " : "• "}
                  {o.agentId}: <Text bold>{o.command}</Text>
                </Text>
                {o.mandatory && o.reason ? (
                  <Text color={theme.fg.muted}>{"     "}{o.reason}</Text>
                ) : null}
              </Box>
            ))}
          </Box>
        ) : null}
        <Text color={theme.fg.muted}>
          [↑↓] move · [Enter] paste · [o] open URL · [s] skip · [c] continue · [Esc] back
        </Text>
        {!complete && totalErrors === 0 ? (
          <Text color={theme.accent.warning}>
            ⚠ {res.secrets.filter((s) => s.status === "missing").length} secret(s) still missing
          </Text>
        ) : null}
        {complete ? (
          <Text color={theme.accent.primary}>
            ✓ Ready to install — press [c] or [Enter] to continue
          </Text>
        ) : null}
      </Box>
    );
  }

  // ---------------- Install ----------------
  if (currentStep === "install") {
    if (!installRunning) {
      setInstallRunning(true);
      setInstallStartedAt(Date.now());
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
    // #459 — Render path. Split the streamed log into Foreman's own
    // headline markers (✓/✗/⚠/▸) + a single rotating milestone line
    // sourced from the upstream installer chatter. On error
    // (pendingFailure) we flip back to verbose so the user can see the
    // actual failure context. Full log stays available via the Done
    // screen's [l] hotkey.
    const classified = classifyInstallLog(installLog);
    const verboseMode = pendingFailure !== null;
    const spinnerChar =
      BRAILLE_SPINNER_FRAMES[spinnerFrame % BRAILLE_SPINNER_FRAMES.length]!;
    const elapsedMs = installStartedAt ? Date.now() - installStartedAt : 0;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          current={4}
          total={4}
          label="Install + configure"
          phase={installRunning ? "running" : "ready"}
        />
        {verboseMode ? (
          installLog.map((line, i) => {
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
          })
        ) : (
          <Box flexDirection="column">
            {classified.headlines.map((line, i) => {
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
            {installRunning && !installSummary ? (
              <Box flexDirection="row">
                <Text color={theme.accent.primary} bold>
                  {`  ${spinnerChar} `}
                </Text>
                <Text color={theme.fg.muted}>
                  {classified.currentAgentName
                    ? `installing ${classified.currentAgentName}… ${formatElapsed(elapsedMs)}  `
                    : `installing… ${formatElapsed(elapsedMs)}  `}
                </Text>
                <Text color={theme.fg.muted}>
                  {classified.lastMilestone ?? "preparing"}
                </Text>
              </Box>
            ) : null}
            {classified.verboseLineCount > 0 ? (
              <Text color={theme.fg.muted}>
                {`  (${classified.verboseLineCount} verbose line${classified.verboseLineCount === 1 ? "" : "s"} collapsed — press [l] later for full log)`}
              </Text>
            ) : null}
          </Box>
        )}
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
          (exit code {doctorReport.exitCode}) — [Esc] / [Enter] / [b] back
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
        <Text color={theme.fg.muted}>[Esc] / [Enter] / [b] back</Text>
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
          {/* #472 — Name the agents whose identity push failed + the
              underlying reason. Previously the count masked which agent
              broke, so the user had no path forward when the Telegram
              flow later said "Provider authentication failed". */}
          {installSummary.identitySkipped.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.accent.warning} bold>
                ⚠ Identity push failed for these agents:
              </Text>
              {installSummary.identitySkipped.map((s) => (
                <Box key={s.agentId} flexDirection="column" marginLeft={2}>
                  <Text color={theme.accent.warning}>
                    ✗ {s.agentId}
                  </Text>
                  <Text color={theme.fg.muted}>
                    {"    "}{s.reason}
                  </Text>
                  <Text color={theme.fg.muted}>
                    {"    "}retry: foreman doctor — diagnoses + suggests fix
                  </Text>
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      )}
      {/* #audit-finding-15 — Agents that registered but whose Foreman
          MCP registration failed are functional for chat but can't call
          Foreman tools. Without surfacing the failure on Done the user
          assumes everything's wired and only sees the gap when an agent
          tries (and fails) to invoke a Foreman MCP tool. */}
      {installSummary && installSummary.mcpRegisterFailed.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.accent.warning}>
            ⚠ Foreman MCP registration failed for these agents:
          </Text>
          {installSummary.mcpRegisterFailed.map((f) => (
            <Box key={f.agentId} flexDirection="column" marginLeft={2}>
              <Text color={theme.accent.warning}>✗ {f.agentId}</Text>
              <Text color={theme.fg.muted}>{"    "}{f.reason}</Text>
              <Text color={theme.fg.muted}>{"    "}retry: {f.command}</Text>
            </Box>
          ))}
          <Text color={theme.fg.muted}>
            These agents will run but can't call Foreman tools until the
            command above succeeds.
          </Text>
        </Box>
      )}
      {installSummary && installSummary.registered.length > 0 && (
        <LaunchCommands agentIds={installSummary.registered} />
      )}
      {/* #408 / #411 Phase 3 — surface queued OAuth flows that the user
          accepted to run manually. Without this hint the wizard would
          leave Codex / Claude Code in an un-authenticated state and the
          user wouldn't know which command to run. #461 splits mandatory
          cross-agent OAuth dependencies into a separate must-do block;
          skipping those leaves the agent unable to talk to its provider
          (silent failure on first message). */}
      {requiredSetupResolution.oauthSteps.filter((o) => o.mandatory).length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.accent.warning}>
            ⚠ Mandatory — these MUST run before the agent can reach its
            provider
          </Text>
          {requiredSetupResolution.oauthSteps
            .filter((o) => o.mandatory)
            .map((o) => (
              <Box
                key={`${o.agentId}-${o.command}`}
                flexDirection="column"
                marginLeft={2}
              >
                <Box flexDirection="row">
                  <Text color={theme.accent.warning}>▸ {o.command}</Text>
                  <Text color={theme.fg.muted}>
                    {"  "}({o.agentId}
                    {o.verify ? ` · verify: ${o.verify}` : ""})
                  </Text>
                </Box>
                {o.reason ? (
                  <Text color={theme.fg.muted}>{"  "}{o.reason}</Text>
                ) : null}
              </Box>
            ))}
        </Box>
      )}
      {requiredSetupResolution.oauthSteps.filter((o) => !o.mandatory).length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Run these to finish OAuth setup</Text>
          {requiredSetupResolution.oauthSteps
            .filter((o) => !o.mandatory)
            .map((o) => (
              <Box
                key={`${o.agentId}-${o.command}`}
                flexDirection="row"
                marginLeft={2}
              >
                <Text color={theme.accent.primary}>▸ {o.command}</Text>
                <Text color={theme.fg.muted}>
                  {"  "}({o.agentId}
                  {o.verify ? ` · verify: ${o.verify}` : ""})
                </Text>
              </Box>
            ))}
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>What next?</Text>
        <Text color={theme.fg.muted}>
          {"  "}[Enter] Launch Foreman TUI
        </Text>
        {requiredSetupResolution.oauthSteps.length > 0 ? (
          <Text color={theme.accent.warning}>
            {"  "}[y]     Run OAuth setup now (opens browser){" "}
            {requiredSetupResolution.oauthSteps.some((o) => o.mandatory)
              ? "— recommended"
              : ""}
          </Text>
        ) : null}
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
  /** #450 — Variant id within the chosen llmProvider's mapping
   *  (e.g. "via-openrouter" or "via-codex-oauth" for Hermes/openai).
   *  Optional; falls back to the registry's `preferred` when unset. */
  providerVariant?: string;
  /** #434 — Specific model id chosen for this agent (e.g.
   *  claude-opus-4-7). Optional; falls back to the variant default. */
  modelVersion?: string;
  responsibilityNote?: string;
}

export type AgentConfigsMap = Record<string, AgentConfig | undefined>;

export interface InstallStepSummary {
  registered: string[];
  identityPushed: string[];
  identitySkipped: { agentId: string; reason: string }[];
  failed: string[];
  removed: string[];
  /** #audit-finding-15 — Agents whose Foreman MCP registration failed
   *  during install (auto-run command refused, wrapper write blocked,
   *  Hermes' `hermes mcp add` errored). The agent runs but its MCP
   *  client can't reach Foreman — silent degradation. Done screen
   *  surfaces these with the manual fallback command so the user can
   *  re-run after fixing the underlying issue. */
  mcpRegisterFailed: { agentId: string; command: string; reason: string }[];
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
    mcpRegisterFailed: [],
  };
  const { doc } = loadActiveRegistry();
  // #373 — load provider catalog once so checkSecrets can filter
  // cross-provider required_secrets per the user's per-agent llmProvider.
  const providerCatalog = loadActiveProviders().doc.providers;

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
        // Script-based installers don't carry an uninstall command; the
        // user has to clean up the binary themselves regardless of shape.
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
      // #458 — Smoke-test the discovered binary so broken shims (the
      // wiped-venv crash QA hit) trigger a reinstall instead of being
      // logged as "already installed".
      const detection = detectInstall(entry.install, process.env, {
        smokeTest: true,
      });
      if (detection.found) {
        log(`  ✓ already installed at ${detection.path}`);
        break;
      }
      if (detection.brokenAt) {
        log(`  ⚠ found broken binary at ${detection.brokenAt} — reinstalling`);
        log(`    ${detection.brokenReason ?? "(no diagnostic)"}`);
      }
      // #369 — Delegate command construction to the platform-aware
      // picker so Windows users get the PowerShell form and so the
      // wizard log doesn't render `[object Object]` when `script` is
      // an object.
      const installCmd = preferredInstallCommand(entry.install);
      if (!installCmd) {
        // No installer available for this platform — log a manual hint
        // before bailing so the user knows what to do next (WSL2,
        // download page, etc).
        if (process.platform === "win32" && entry.install.script) {
          log(
            `  ⚠ ${entry.name} has no native Windows installer. Run inside WSL2 or install from ${entry.homepage}.`,
          );
        } else {
          log(
            `  ⚠ ${entry.name} has no automated installer for this platform — install manually from ${entry.homepage}.`,
          );
        }
        break;
      }
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

    // #373 — Pass the user's per-agent llmProvider so checkSecrets drops
    // cross-provider required_secrets (e.g. OpenClaw's anthropic-key when
    // user picked openai). Without this filter, Foreman warns about keys
    // the user doesn't need.
    const secretCheck = checkSecrets(entry, services.secretStore, {
      llmProvider: agentConfigs[id]?.llmProvider,
      providerCatalog,
    });
    if (!secretCheck.hasAllRequired) {
      const missing = secretCheck.required
        .filter((s) => !s.present)
        .map((s) => s.name);
      log(
        `  ⚠ required secrets missing: ${missing.join(", ")} — add via 'foreman secrets add <name>'`,
      );
    }

    const configPath = pickConfigPath(entry);
    const requiresExisting = entry.install.requires_existing_config === true;
    if (configPath) {
      try {
        // #385 — Seed bundled template first when the agent's config file
        // doesn't exist (OpenClaw). Template ships under
        // registry/templates/<agent>.json; Foreman writes it expanded so
        // the MCP/secret overlay lands on a schema-valid base. Replaces
        // the #377/#378 "skip + manual repush" workaround.
        const templatePath = entry.install.config_template_path
          ? resolveBundledTemplatePath(entry.install.config_template_path)
          : null;
        let seeded = false;
        if (!existsSync(configPath) && templatePath) {
          try {
            const raw = readFileSync(templatePath, "utf-8");
            const expanded = raw.replace(/~\//g, `${homedir()}/`);
            mkdirSync(dirname(configPath), { recursive: true });
            writeFileSync(configPath, expanded, { mode: 0o600 });
            seeded = true;
            log(
              `  ✓ seeded ${entry.name} config from bundled template → ${configPath}`,
            );
          } catch (seedErr) {
            log(
              `  ⚠ template seed failed: ${seedErr instanceof Error ? seedErr.message : String(seedErr)}`,
            );
          }
        }
        // #377 fallback — when no template is bundled AND the registry
        // flags requires_existing_config, leave the file alone and hint.
        if (!seeded && requiresExisting && !existsSync(configPath)) {
          log(
            `  ⚠ ${entry.name} config not initialised at ${configPath}`,
          );
          log(
            `     Run \`${entry.install.binary ?? id}\` once to create it, then \`foreman secrets repush ${id}\` to apply Foreman's keys.`,
          );
        } else {
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
      // #471 — Mirror the register-time fallback so projection sees the
      // resolved provider for single-compat agents.
      const projCompat = entry.llm_compat ?? [];
      const projProvider =
        agentConfigs[id]?.llmProvider ??
        (projCompat.length === 1 ? projCompat[0] : undefined);
      const projection = projectSecretsForAgent(entry, {
        providersSelected: projectionCtx.providersSelected,
        servicesSelected: projectionCtx.servicesSelected,
        // #389 — per-agent llmProvider so config_overrides' if_provider
        // resolves to the user's per-agent pick (not the global Step 1 set).
        llmProvider: projProvider,
        // #450 — per-agent variant override (e.g. Codex OAuth instead
        // of OpenRouter for Hermes/openai).
        providerVariant: agentConfigs[id]?.providerVariant,
        // #434 — per-agent specific model id chosen in the wizard's
        // model-pick phase; falls back to the variant default when omitted.
        modelVersion: agentConfigs[id]?.modelVersion,
        secretStore: services.secretStore,
        // #426 — Skip channel-tied writes for agents that aren't the
        // primary for a messaging channel.
        chatPrimary: services.chatPrimary,
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

    // #394 — Disable any agent-managed macOS LaunchAgent so Foreman's
    // daemon manager has sole ownership. Hermes' installer drops one
    // that auto-respawns the gateway across reboots; without this
    // disable, two Hermes processes fight for the Telegram bot token.
    // No-op on non-macOS hosts. Idempotent: bootout returns success
    // when not loaded, rename is skipped when already renamed.
    if (entry.install.macos_launch_agent_disable) {
      try {
        const r = await disableManagedLaunchAgent(
          entry.install.macos_launch_agent_disable,
        );
        if (r.platformSkipped) {
          // Don't log — non-macOS users don't need to hear about LaunchAgents.
        } else if (r.plistRenamed) {
          log(
            `  ✓ disabled ${entry.install.macos_launch_agent_disable.label} LaunchAgent (Foreman daemon owns the process now)`,
          );
        } else if (r.bootedOut) {
          log(`  ◦ ${entry.install.macos_launch_agent_disable.label} LaunchAgent already disabled`);
        }
        for (const err of r.errors) {
          log(`  ⚠ ${err}`);
        }
      } catch (err) {
        log(
          `  ⚠ LaunchAgent disable failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // #398 — post-config commands. Run registry-declared shell steps
    // AFTER secrets are projected to the agent's config, so service
    // installers (OpenClaw's `gateway install` LaunchAgent registration)
    // run against valid config. Best-effort — non-zero exits surface
    // as warnings; the daemon manager catches the real failure on next
    // `foreman start` if the gateway still doesn't come up.
    const postCmds = entry.install.post_config_commands ?? [];
    if (postCmds.length > 0) {
      try {
        const results = await runPostConfigCommands(entry.install, (line) =>
          log(`    ${line}`),
        );
        for (const r of results) {
          if (r.ok) {
            log(`  ✓ ${r.command}`);
          } else {
            log(`  ⚠ ${r.command} exited ${r.exitCode}`);
          }
        }
      } catch (err) {
        log(
          `  ⚠ post-config commands failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (services.registry.get(id)) {
      log(`  ◦ already registered`);
      continue;
    }
    try {
      const cfg = agentConfigs[id];
      // #471 — Belt-and-braces fallback: if cfg.llmProvider somehow leaked
      // through unset (e.g. a wizard phase regression) AND the agent has
      // exactly one compatible provider, pick that one. Prevents the silent
      // null-provider state that caused the round-3 "1 of 2 agents" bug.
      const compat = entry.llm_compat ?? [];
      const resolvedProvider =
        cfg?.llmProvider ?? (compat.length === 1 ? compat[0] : undefined);
      registerAgent({
        agentId: id,
        entry,
        registry: services.registry,
        llmProvider: resolvedProvider,
        providerVariant: cfg?.providerVariant,
        modelVersion: cfg?.modelVersion,
        responsibilityNote: cfg?.responsibilityNote,
      });
      summary.registered.push(id);
      log(`  ✓ registered as "${id}"`);
      if (resolvedProvider) log(`    LLM provider: ${resolvedProvider}`);
      if (cfg?.providerVariant) log(`    Provider variant: ${cfg.providerVariant}`);
      if (cfg?.modelVersion) log(`    Model: ${cfg.modelVersion}`);
      if (cfg?.responsibilityNote)
        log(`    Responsibility: ${cfg.responsibilityNote}`);
      // Some agents (Hermes) keep their own MCP server registry CLI-side
      // and don't read the YAML block we injected. #460 — auto-runs the
      // CLI command via `printf 'y\n' | <cmd>` so the user doesn't have
      // to do it manually. Falls back to the manual hint when the run
      // fails (binary missing, prompt won't pipe, etc).
      const registerHint = buildMcpRegisterHint(id, entry);
      if (registerHint) {
        // #346 — write the wrapper script for agents (Hermes) that can't
        // accept multi-token --args.
        let wrapperOk = true;
        if (registerHint.wrapper) {
          try {
            const wrote = writeMcpWrapperScript(registerHint.wrapper);
            log(
              `  ${wrote ? "✓ wrote" : "✓ wrapper present"} ${registerHint.wrapper.path}`,
            );
          } catch (err) {
            wrapperOk = false;
            const reason = err instanceof Error ? err.message : String(err);
            log(`  ⚠ wrapper write failed: ${reason}`);
          }
        }
        // Only attempt auto-run when the wrapper is in place (or no
        // wrapper required).
        if (wrapperOk) {
          const autoOutcome = await autoRegisterMcp(registerHint.command, runShell);
          if (autoOutcome.ok) {
            log(`  ✓ registered Foreman MCP with ${entry.name}`);
            if (autoOutcome.firstOutputLine) {
              log(`    ${autoOutcome.firstOutputLine}`);
            }
            if (registerHint.verify) {
              log(`    verify: ${registerHint.verify}`);
            }
          } else {
            log(`  ⚠ auto-register failed (${autoOutcome.error}) — run manually:`);
            if (registerHint.note) log(`    ${registerHint.note}`);
            log(`    $ ${registerHint.command}`);
            if (registerHint.verify) {
              log(`    verify with: ${registerHint.verify}`);
            }
            // #audit-finding-15 — Capture the failure on the summary so
            // the Done screen surfaces it. Agent still runs; without
            // MCP it just can't call Foreman tools.
            summary.mcpRegisterFailed.push({
              agentId: id,
              command: registerHint.command,
              reason: autoOutcome.error ?? "auto-register failed",
            });
          }
        } else {
          // Wrapper write failed — still print the manual fallback.
          log(`  ℹ ${entry.name} needs one extra step to route through Foreman:`);
          if (registerHint.note) log(`     ${registerHint.note}`);
          log(`     $ ${registerHint.command}`);
          summary.mcpRegisterFailed.push({
            agentId: id,
            command: registerHint.command,
            reason: "wrapper script write failed",
          });
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
