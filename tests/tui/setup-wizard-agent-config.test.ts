import { describe, expect, it } from "vitest";
import {
  applyAgentConfigSubmit,
  buildAgentConfigPromptList,
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

  it("emits only a note prompt for single-provider agents", () => {
    const prompts = buildAgentConfigPromptList(catalog, ["claude-code"]);
    expect(prompts).toEqual([
      { agentId: "claude-code", kind: "responsibility-note" },
    ]);
  });

  it("emits LLM choice then note for multi-provider agents", () => {
    const prompts = buildAgentConfigPromptList(catalog, ["hermes"]);
    expect(prompts).toEqual([
      { agentId: "hermes", kind: "llm-choice" },
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

  it("flattens mixed selections in selection order", () => {
    const prompts = buildAgentConfigPromptList(catalog, [
      "claude-code",
      "hermes",
      "codex",
    ]);
    expect(prompts).toEqual([
      { agentId: "claude-code", kind: "responsibility-note" },
      { agentId: "hermes", kind: "llm-choice" },
      { agentId: "hermes", kind: "responsibility-note" },
      { agentId: "codex", kind: "responsibility-note" },
    ]);
  });

  it("skips selections not in the catalog (defensive)", () => {
    const prompts = buildAgentConfigPromptList(catalog, [
      "ghost",
      "claude-code",
    ]);
    expect(prompts).toEqual([
      { agentId: "claude-code", kind: "responsibility-note" },
    ]);
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
