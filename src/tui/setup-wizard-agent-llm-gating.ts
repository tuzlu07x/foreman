import type { AgentEntry, ProviderEntry } from "../core/registry-catalog.js";

// =============================================================================
// Smart agent-LLM gating (#297)
// =============================================================================
//
// User vision:
//   "Kullanıcı setup'ta hangi LLM provider'lara erişimi varsa key'lerini
//    girer. Multi-provider agent'lar (Hermes, OpenClaw) için kullanıcı setup'ta
//    seçer. Single-provider agent'lar (Claude Code → Anthropic, Codex →
//    OpenAI) zorunlu, seçim yok. Eğer LLM keyi eklenmemişse 'key ekleyin' veya
//    'farklı agent seçin' demeliyiz."
//
// Pure logic for computing per-agent gating state given:
//   - the agent's llm_compat list
//   - the provider catalog (resolves ids → display names)
//   - the set of provider ids the user has already configured (via the
//     wizard's providers step OR pre-existing secrets in the vault)

export type AgentLlmGateState =
  /** Agent declares no LLM constraint (generic-mcp) — always selectable. */
  | "no-constraint"
  /** Exactly one compatible LLM is configured — auto-selected, no picker. */
  | "auto-single"
  /** Multiple compatible LLMs configured — user picks during agent config. */
  | "user-choice"
  /** No compatible LLM configured — agent is selectable only after adding
   *  one of `requiredAnyOf`. UI gates this. */
  | "needs-llm";

export interface AgentLlmGateStatus {
  agentId: string;
  state: AgentLlmGateState;
  /** Provider ids (from the catalog) that ARE configured + match the
   *  agent's compat — drives the dropdown for `user-choice`. */
  availableProviders: string[];
  /** For `needs-llm`: any one of these would unlock the agent. Empty for
   *  the other states. */
  requiredAnyOf: string[];
  /** Pre-formatted human-readable hint for the picker UI — e.g.
   *  "needs anthropic key (configure in Step 1)". Empty when state is OK. */
  hint: string;
}

export interface ComputeAgentLlmStatusInput {
  agent: AgentEntry;
  providerCatalog: ProviderEntry[];
  /** Provider ids the user has configured (see `configuredProviderIds`
   *  in setup-wizard.tsx — derived from secret store + endpoint refs). */
  configuredProviderIds: string[];
}

/**
 * Decide the gate state for a single agent.
 *
 * - `llm_compat: []` (or absent) → always selectable (generic-mcp)
 * - `llm_compat: ["openai"]` with openai configured → auto-single
 * - `llm_compat: ["openai"]` without openai configured → needs-llm
 * - `llm_compat: ["anthropic", "openai"]` with both configured → user-choice
 * - `llm_compat: ["anthropic", "openai"]` with one configured → auto-single
 * - `llm_compat: ["anthropic", "openai"]` with neither configured → needs-llm
 */
export function computeAgentLlmStatus(
  input: ComputeAgentLlmStatusInput,
): AgentLlmGateStatus {
  const compat = input.agent.llm_compat ?? [];
  if (compat.length === 0) {
    return {
      agentId: input.agent.id,
      state: "no-constraint",
      availableProviders: [],
      requiredAnyOf: [],
      hint: "",
    };
  }

  const configured = new Set(input.configuredProviderIds);
  const available = compat.filter((id) => configured.has(id));

  if (available.length === 0) {
    return {
      agentId: input.agent.id,
      state: "needs-llm",
      availableProviders: [],
      requiredAnyOf: compat,
      hint: buildNeedsLlmHint(compat, input.providerCatalog),
    };
  }

  if (available.length === 1 || compat.length === 1) {
    // Either only one option in compat (single-provider agent) or only one
    // of multiple is configured. Either way: no picker, auto-select.
    return {
      agentId: input.agent.id,
      state: "auto-single",
      availableProviders: available,
      requiredAnyOf: [],
      hint: "",
    };
  }

  return {
    agentId: input.agent.id,
    state: "user-choice",
    availableProviders: available,
    requiredAnyOf: [],
    hint: "",
  };
}

/** Convenience: compute statuses for many agents at once. */
export function computeAgentLlmStatuses(
  agents: AgentEntry[],
  providerCatalog: ProviderEntry[],
  configuredProviderIds: string[],
): Map<string, AgentLlmGateStatus> {
  const out = new Map<string, AgentLlmGateStatus>();
  for (const agent of agents) {
    out.set(
      agent.id,
      computeAgentLlmStatus({
        agent,
        providerCatalog,
        configuredProviderIds,
      }),
    );
  }
  return out;
}

function buildNeedsLlmHint(
  required: string[],
  catalog: ProviderEntry[],
): string {
  // Resolve provider ids → display names where possible, fall back to id.
  const names = required.map((id) => {
    const entry = catalog.find((p) => p.id === id);
    return entry?.name ?? id;
  });
  if (names.length === 1) return `needs ${names[0]} key`;
  if (names.length === 2)
    return `needs ${names[0]} or ${names[1]} key`;
  const last = names[names.length - 1];
  return `needs ${names.slice(0, -1).join(", ")} or ${last} key`;
}
