import type { AgentEntry } from "../../core/registry-catalog.js";
import type { AgentConfig } from "./types.js";

// Same phase-machine pattern as Secrets — the old `agentsDone` boolean made
// the picker drop straight into install with no confirmation step, so a
// silently-defaulted selection couldn't be caught before it ran (#152).
// `per-agent-config` is the sub-step inserted between picker and confirm
// where multi-provider agents pick an LLM and every agent gets an optional
// responsibility note (#174).
export type AgentsPhase = "picker" | "per-agent-config" | "confirm" | "running";

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

/**
 * #469 — When the user highlights an OAuth / no-key variant in the
 * variant picker, scan SIBLING variants in the same provider mapping.
 * If any sibling's `required_secret` is already in the secret store,
 * return a one-line note like "You have openrouter-key — picking
 * 'OpenAI via OpenRouter' would skip the codex login step." When no
 * sibling matches a stored secret, returns null.
 *
 * Prevents the silent footgun where users paste a key in Step 1, pick
 * an unrelated OAuth route here, and end up debugging why the key
 * isn't doing anything.
 *
 * NOTE: PR #474 merged the call site at the variant-pick render block
 * but lost this definition during rebase resolution — fixed forward by
 * reintroducing the helper. The prior file in the PR also had this
 * exact body next to classifyModelDiscoveryError.
 */
export function findSiblingCredHint(
  providerMapping: {
    variants: Record<
      string,
      { label: string; required_secret?: string | null | undefined }
    >;
  },
  currentVariantId: string,
  storedSecrets: Set<string>,
): string | null {
  for (const [vid, variant] of Object.entries(providerMapping.variants)) {
    if (vid === currentVariantId) continue;
    const sibSecret = variant.required_secret;
    if (!sibSecret) continue;
    if (storedSecrets.has(sibSecret)) {
      return `You have ${sibSecret} stored — picking "${variant.label}" would use that key directly (no OAuth setup needed).`;
    }
  }
  return null;
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

/**
 * Whether the variant-pick prompt is actually shown for this agent, or
 * auto-skipped by the wizard (#450 single variant, #457 no-credential
 * preferred route that was picked on the user's behalf).
 */
export function variantPickIsShown(
  agent: AgentEntry | undefined,
  cfg: AgentConfig | undefined,
  autoPicked: { variantId: string } | undefined,
): boolean {
  const compat = agent?.llm_compat ?? [];
  const provider =
    cfg?.llmProvider ?? (compat.length === 1 ? compat[0] : undefined);
  if (!provider || !agent?.provider_mapping) return false;
  const mapping = agent.provider_mapping[provider];
  const variantCount = mapping ? Object.keys(mapping.variants).length : 0;
  if (variantCount <= 1) return false;
  if (autoPicked && autoPicked.variantId === cfg?.providerVariant) return false;
  return true;
}

/**
 * Esc target inside the per-agent config queue: the nearest earlier prompt
 * for the SAME agent that is actually shown. Auto-skipped prompts are
 * stepped over — landing on one would bounce straight back (Esc used to
 * loop on model-pick for single-variant agents). Returns null when the
 * agent has no earlier shown prompt; the caller then returns to the agents
 * picker instead of the previous agent's responsibility note.
 */
export function previousShownAgentPromptIdx(
  prompts: readonly AgentConfigPrompt[],
  idx: number,
  isShown: (prompt: AgentConfigPrompt) => boolean,
): number | null {
  const current = prompts[idx];
  if (!current) return null;
  for (let i = idx - 1; i >= 0; i--) {
    const prompt = prompts[i];
    if (!prompt || prompt.agentId !== current.agentId) return null;
    if (isShown(prompt)) return i;
  }
  return null;
}

/**
 * Commit an llm-choice pick. Switching to a different provider drops the
 * variant + model chosen for the old one — they belong to that provider's
 * mapping and would otherwise be registered against the new one.
 */
export function applyLlmChoice(
  existing: AgentConfig,
  llmProvider: string,
): AgentConfig {
  const next: AgentConfig = { ...existing, llmProvider };
  if (existing.llmProvider !== llmProvider) {
    delete next.providerVariant;
    delete next.modelVersion;
  }
  return next;
}
