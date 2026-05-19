import { describe, expect, it } from "vitest";
import {
  applyAgentConfigSubmit,
  buildAgentConfigPromptList,
  findSiblingCredHint,
} from "../../src/tui/setup-wizard.js";
import type { AgentEntry } from "../../src/core/registry-catalog.js";

function agent(overrides: Partial<AgentEntry>): AgentEntry {
  return {
    id: "hermes",
    name: "Hermes",
    tagline: "Personal assistant",
    homepage: "https://example.com/",
    install: { npm: null, brew: null },
    config_paths: [],
    required_secrets: [],
    optional_secrets: [],
    mcp_compatible: true,
    supported_versions: ">=1.0.0",
    min_foreman_version: "0.1.2",
    ...overrides,
  } as AgentEntry;
}

describe("buildAgentConfigPromptList", () => {
  const claudeCode = agent({ id: "claude-code", llm_compat: ["anthropic"] });
  const hermes = agent({ id: "hermes", llm_compat: ["anthropic", "openai"] });
  const codex = agent({ id: "codex", llm_compat: ["openai"] });
  const generic = agent({ id: "generic-mcp", llm_compat: [] });
  const noField = agent({ id: "legacy" });
  const catalog: AgentEntry[] = [claudeCode, hermes, codex, generic, noField];

  it("emits model-pick + note for single-provider agents (#434)", () => {
    const prompts = buildAgentConfigPromptList(catalog, ["claude-code"]);
    expect(prompts).toEqual([
      { agentId: "claude-code", kind: "model-pick" },
      { agentId: "claude-code", kind: "responsibility-note" },
    ]);
  });

  it("emits llm-choice, model-pick, then note for multi-provider agents (#434)", () => {
    const prompts = buildAgentConfigPromptList(catalog, ["hermes"]);
    expect(prompts).toEqual([
      { agentId: "hermes", kind: "llm-choice" },
      { agentId: "hermes", kind: "model-pick" },
      { agentId: "hermes", kind: "responsibility-note" },
    ]);
  });

  it("emits only a note prompt for empty-compat agents (no constraint)", () => {
    const prompts = buildAgentConfigPromptList(catalog, ["generic-mcp"]);
    expect(prompts).toEqual([
      { agentId: "generic-mcp", kind: "responsibility-note" },
    ]);
  });

  it("treats legacy entries (no llm_compat field) as single-provider", () => {
    const prompts = buildAgentConfigPromptList(catalog, ["legacy"]);
    expect(prompts).toEqual([
      { agentId: "legacy", kind: "responsibility-note" },
    ]);
  });

  it("flattens mixed selections in selection order (#434 adds model-pick per agent)", () => {
    const prompts = buildAgentConfigPromptList(catalog, [
      "claude-code",
      "hermes",
      "codex",
    ]);
    expect(prompts).toEqual([
      { agentId: "claude-code", kind: "model-pick" },
      { agentId: "claude-code", kind: "responsibility-note" },
      { agentId: "hermes", kind: "llm-choice" },
      { agentId: "hermes", kind: "model-pick" },
      { agentId: "hermes", kind: "responsibility-note" },
      { agentId: "codex", kind: "model-pick" },
      { agentId: "codex", kind: "responsibility-note" },
    ]);
  });

  it("skips selections not in the catalog (defensive)", () => {
    const prompts = buildAgentConfigPromptList(catalog, [
      "ghost",
      "claude-code",
    ]);
    expect(prompts).toEqual([
      { agentId: "claude-code", kind: "model-pick" },
      { agentId: "claude-code", kind: "responsibility-note" },
    ]);
  });

  // #297 — when configuredProviderIds is passed, gating narrows the picker.
  // #355 — for multi-LLM-compat agents we keep the picker visible even when
  // only one option is configured, so the user can SEE which LLM was wired
  // (and Enter to confirm). Skipping silently picked the sole option and
  // round-3 users couldn't tell what they ended up with.
  describe("with configuredProviderIds gating", () => {
    it("keeps llm-choice for multi-compat agent even when only one is configured (#355)", () => {
      // Hermes compat = [anthropic, openai], user has only anthropic — still
      // show picker so user can visually confirm. model-pick follows since
      // at least one provider is configured (#434).
      const prompts = buildAgentConfigPromptList(
        catalog,
        ["hermes"],
        ["anthropic"],
      );
      expect(prompts).toEqual([
        { agentId: "hermes", kind: "llm-choice" },
        { agentId: "hermes", kind: "model-pick" },
        { agentId: "hermes", kind: "responsibility-note" },
      ]);
    });

    it("keeps llm-choice when 2+ compatible LLMs are configured", () => {
      const prompts = buildAgentConfigPromptList(
        catalog,
        ["hermes"],
        ["anthropic", "openai"],
      );
      expect(prompts).toEqual([
        { agentId: "hermes", kind: "llm-choice" },
        { agentId: "hermes", kind: "model-pick" },
        { agentId: "hermes", kind: "responsibility-note" },
      ]);
    });

    it("skips llm-choice + model-pick when zero compatible LLMs are configured", () => {
      // needs-llm state — no point showing a 0-option picker.
      const prompts = buildAgentConfigPromptList(catalog, ["hermes"], ["gemini"]);
      expect(prompts).toEqual([
        { agentId: "hermes", kind: "responsibility-note" },
      ]);
    });

    it("ignores configured providers that are NOT in agent compat (#434 still emits model-pick)", () => {
      // Codex (compat=[openai]) — user has anthropic+openai, but only
      // openai counts for codex. Compat length is 1 → no llm-choice, but
      // model-pick still fires since the sole compat is configured.
      const prompts = buildAgentConfigPromptList(
        catalog,
        ["codex"],
        ["anthropic", "openai"],
      );
      expect(prompts).toEqual([
        { agentId: "codex", kind: "model-pick" },
        { agentId: "codex", kind: "responsibility-note" },
      ]);
    });

    it("falls back to original behaviour when configuredProviderIds omitted", () => {
      const prompts = buildAgentConfigPromptList(catalog, ["hermes"]);
      expect(prompts).toEqual([
        { agentId: "hermes", kind: "llm-choice" },
        { agentId: "hermes", kind: "model-pick" },
        { agentId: "hermes", kind: "responsibility-note" },
      ]);
    });

    it("never shows llm-choice for single-compat agents but model-pick still fires (#434)", () => {
      // Claude Code is anthropic-only — no llm-choice ever; model-pick
      // appears because at least one configured compat exists.
      const prompts = buildAgentConfigPromptList(
        catalog,
        ["claude-code"],
        ["anthropic", "openai"],
      );
      expect(prompts).toEqual([
        { agentId: "claude-code", kind: "model-pick" },
        { agentId: "claude-code", kind: "responsibility-note" },
      ]);
    });
  });

  // #450 — Variant pick prompt emitted whenever agent has
  // provider_mapping. Runtime auto-skips single-variant providers; the
  // prompt list always includes it (build time can't see picked provider).
  describe("variant-pick (#450)", () => {
    function withMapping(id: string, llm_compat: string[]): AgentEntry {
      return agent({
        id,
        llm_compat,
        provider_mapping: {
          openai: {
            preferred: "via-openrouter",
            variants: {
              "via-openrouter": {
                label: "OpenRouter → OpenAI",
                writes: { "model.default": "openai/${model}" },
                required_secret: "openrouter-key",
              },
              "via-codex-oauth": {
                label: "Codex OAuth → OpenAI",
                writes: { "model.default": "openai/${model}" },
                required_secret: null,
              },
            },
          },
          anthropic: {
            preferred: "direct",
            variants: {
              direct: {
                label: "Anthropic direct",
                writes: { "model.default": "claude/${model}" },
                required_secret: "anthropic-key",
              },
            },
          },
        },
      }) as AgentEntry;
    }

    it("emits variant-pick after llm-choice for multi-compat agent with provider_mapping", () => {
      const mapped = withMapping("hermes-mapped", ["anthropic", "openai"]);
      const prompts = buildAgentConfigPromptList(
        [mapped],
        ["hermes-mapped"],
        ["anthropic", "openai"],
      );
      expect(prompts).toEqual([
        { agentId: "hermes-mapped", kind: "llm-choice" },
        { agentId: "hermes-mapped", kind: "variant-pick" },
        { agentId: "hermes-mapped", kind: "model-pick" },
        { agentId: "hermes-mapped", kind: "responsibility-note" },
      ]);
    });

    it("emits variant-pick for single-compat agent that has provider_mapping (#434 keeps model-pick too)", () => {
      const mapped = withMapping("codex-mapped", ["openai"]);
      const prompts = buildAgentConfigPromptList(
        [mapped],
        ["codex-mapped"],
        ["openai"],
      );
      expect(prompts).toEqual([
        { agentId: "codex-mapped", kind: "variant-pick" },
        { agentId: "codex-mapped", kind: "model-pick" },
        { agentId: "codex-mapped", kind: "responsibility-note" },
      ]);
    });

    it("skips variant-pick for agents WITHOUT provider_mapping", () => {
      const noMapping = agent({
        id: "legacy-agent",
        llm_compat: ["anthropic", "openai"],
      });
      const prompts = buildAgentConfigPromptList(
        [noMapping],
        ["legacy-agent"],
        ["anthropic", "openai"],
      );
      const kinds = prompts.map((p) => p.kind);
      expect(kinds).not.toContain("variant-pick");
    });

    it("skips variant-pick when no compat provider is configured", () => {
      const mapped = withMapping("hermes-mapped", ["anthropic", "openai"]);
      const prompts = buildAgentConfigPromptList(
        [mapped],
        ["hermes-mapped"],
        ["gemini"], // not in compat
      );
      const kinds = prompts.map((p) => p.kind);
      expect(kinds).not.toContain("variant-pick");
    });
  });
});

describe("applyAgentConfigSubmit", () => {
  it("advances to the next prompt when more remain", () => {
    const result = applyAgentConfigSubmit({
      currentIdx: 0,
      totalPrompts: 3,
    });
    expect(result.nextPhase).toBe("per-agent-config");
    expect(result.nextIdx).toBe(1);
  });

  it("transitions to confirm on the last prompt", () => {
    const result = applyAgentConfigSubmit({
      currentIdx: 2,
      totalPrompts: 3,
    });
    expect(result.nextPhase).toBe("confirm");
    expect(result.nextIdx).toBe(3);
  });

  it("transitions to confirm on a single-prompt loop", () => {
    const result = applyAgentConfigSubmit({
      currentIdx: 0,
      totalPrompts: 1,
    });
    expect(result.nextPhase).toBe("confirm");
    expect(result.nextIdx).toBe(1);
  });
});

// #469 — Cross-variant credential hint. When the user highlights an
// OAuth / no-key variant in the variant picker, surface a note if a
// SIBLING variant's required_secret is already stored. Prevents the
// "I pasted my OpenAI key, why isn't anything using it?" footgun.
describe("findSiblingCredHint (#469)", () => {
  const hermesOpenai = {
    variants: {
      "via-openrouter": {
        label: "OpenAI via OpenRouter",
        required_secret: "openrouter-key",
      },
      "via-codex-oauth": {
        label: "OpenAI via Codex OAuth",
        required_secret: null,
      },
    },
  };

  it("surfaces a hint when sibling needs a stored secret", () => {
    const result = findSiblingCredHint(
      hermesOpenai,
      "via-codex-oauth",
      new Set(["openrouter-key"]),
    );
    expect(result).not.toBeNull();
    expect(result).toContain("openrouter-key");
    expect(result).toContain("OpenAI via OpenRouter");
  });

  it("returns null when no sibling's secret is stored", () => {
    const result = findSiblingCredHint(
      hermesOpenai,
      "via-codex-oauth",
      new Set(["anthropic-key"]),
    );
    expect(result).toBeNull();
  });

  it("returns null when called on the secret-needing variant itself", () => {
    // User is on via-openrouter (which uses openrouter-key) — sibling
    // check should not flag itself.
    const result = findSiblingCredHint(
      hermesOpenai,
      "via-openrouter",
      new Set(["openrouter-key"]),
    );
    expect(result).toBeNull();
  });

  it("ignores siblings that also have null required_secret", () => {
    const allOauth = {
      variants: {
        "oauth-a": { label: "A", required_secret: null },
        "oauth-b": { label: "B", required_secret: null },
      },
    };
    expect(findSiblingCredHint(allOauth, "oauth-a", new Set())).toBeNull();
  });

  it("picks the FIRST matching sibling when multiple credentials are stored", () => {
    const mapping = {
      variants: {
        "via-x": { label: "Route X", required_secret: "x-key" },
        "via-y": { label: "Route Y", required_secret: "y-key" },
        "via-oauth": { label: "OAuth", required_secret: null },
      },
    };
    const result = findSiblingCredHint(
      mapping,
      "via-oauth",
      new Set(["x-key", "y-key"]),
    );
    // Both stored; helper returns the first hit. Either is acceptable but
    // we want a deterministic, non-empty answer.
    expect(result).not.toBeNull();
    expect(result).toMatch(/(x-key|y-key)/);
  });
});
