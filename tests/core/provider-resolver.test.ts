import { describe, expect, it } from "vitest";
import {
  describeResolveError,
  deriveDefaultModelId,
  resolveAgentProviderConfig,
} from "../../src/core/provider-resolver.js";
import {
  loadBundledRegistry,
  type AgentEntry,
} from "../../src/core/registry-catalog.js";

// =============================================================================
// #408 / #410 — Phase 2. Tests the resolver against the bundled registry's
// real provider_mapping data (populated in Phase 1) so any breaking change
// to the mapping shape gets caught here.
// =============================================================================

function getAgent(id: string): AgentEntry {
  const doc = loadBundledRegistry();
  const found = doc.agents.find((a) => a.id === id);
  if (!found) throw new Error(`agent ${id} missing from bundled registry`);
  return found;
}

describe("resolveAgentProviderConfig — happy paths", () => {
  it("Hermes + openai resolves to via-openrouter variant by default", () => {
    const result = resolveAgentProviderConfig({
      agent: getAgent("hermes"),
      foremanProvider: "openai",
      modelId: "gpt-4o-mini",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.variantId).toBe("via-openrouter");
    expect(result.config.variantLabel).toContain("OpenRouter");
    expect(result.config.configWrites["model.provider"]).toBe("openrouter");
    expect(result.config.configWrites["model.default"]).toBe(
      "openai/gpt-4o-mini",
    );
    expect(result.config.requiredSecret).toBe("openrouter-key");
    expect(result.config.secretAcquisition?.url).toBe(
      "https://openrouter.ai/keys",
    );
  });

  it("variantOverride switches Hermes/openai to via-codex-oauth", () => {
    const result = resolveAgentProviderConfig({
      agent: getAgent("hermes"),
      foremanProvider: "openai",
      modelId: "gpt-4o-mini",
      variantOverride: "via-codex-oauth",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.variantId).toBe("via-codex-oauth");
    expect(result.config.interactiveSetup).toBe("hermes model");
    expect(result.config.postSetupVerify).toBe("hermes doctor");
    expect(result.config.requiredSecret).toBeNull();
  });

  it("OpenClaw + openai resolves to native slash-form model", () => {
    const result = resolveAgentProviderConfig({
      agent: getAgent("openclaw"),
      foremanProvider: "openai",
      modelId: "gpt-4o-mini",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.variantId).toBe("native");
    expect(
      result.config.configWrites["agents.defaults.model.primary"],
    ).toBe("openai/gpt-4o-mini");
    expect(result.config.envVars.OPENAI_API_KEY).toContain(
      "${secret:openai-key}",
    );
    expect(result.config.requiredSecret).toBe("openai-key");
  });

  it("Codex + openai resolves to OAuth variant (no required secret)", () => {
    const result = resolveAgentProviderConfig({
      agent: getAgent("codex"),
      foremanProvider: "openai",
      modelId: "gpt-4o-mini",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.variantId).toBe("oauth");
    expect(result.config.interactiveSetup).toBe("codex login");
    expect(result.config.postSetupVerify).toBe("codex auth status");
    expect(result.config.requiredSecret).toBeNull();
    expect(result.config.tomlWrites[0]?.value).toBe("chatgpt");
  });

  it("Codex + openai with api-key override gets auth_json_writes", () => {
    const result = resolveAgentProviderConfig({
      agent: getAgent("codex"),
      foremanProvider: "openai",
      modelId: "gpt-4o-mini",
      variantOverride: "api-key",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.authJsonWrites[0]?.key).toBe("OPENAI_API_KEY");
    expect(result.config.authJsonWrites[0]?.value).toBe(
      "${secret:openai-key}",
    );
    expect(result.config.tomlWrites[0]?.value).toBe("apikey");
  });

  it("Claude Code + anthropic resolves to direct variant with ANTHROPIC_API_KEY", () => {
    const result = resolveAgentProviderConfig({
      agent: getAgent("claude-code"),
      foremanProvider: "anthropic",
      modelId: "claude-haiku-4-5-20251001",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.variantId).toBe("direct");
    expect(result.config.envVars.ANTHROPIC_API_KEY).toBe(
      "${secret:anthropic-key}",
    );
  });

  it("ZeroClaw + anthropic resolves to direct variant with TOML writes", () => {
    const result = resolveAgentProviderConfig({
      agent: getAgent("zeroclaw"),
      foremanProvider: "anthropic",
      modelId: "claude-haiku-4-5-20251001",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.tomlWrites).toHaveLength(2);
    expect(
      result.config.tomlWrites.find((w) => w.key === "default_provider")?.value,
    ).toBe("anthropic");
    expect(
      result.config.tomlWrites.find((w) => w.key === "api_key")?.value,
    ).toBe("${secret:anthropic-key}");
  });
});

describe("resolveAgentProviderConfig — template substitution", () => {
  it("substitutes ${model} in all template fields", () => {
    const result = resolveAgentProviderConfig({
      agent: getAgent("hermes"),
      foremanProvider: "openai",
      modelId: "gpt-5.4-mini",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.configWrites["model.default"]).toBe(
      "openai/gpt-5.4-mini",
    );
  });

  it("substitutes ${secret:<name>} when secretLookup is provided", () => {
    const lookup = (name: string): string | null =>
      name === "openrouter-key" ? "sk-or-real-value-123" : null;
    const result = resolveAgentProviderConfig({
      agent: getAgent("hermes"),
      foremanProvider: "openai",
      modelId: "gpt-4o-mini",
      secretLookup: lookup,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.envVars.OPENROUTER_API_KEY).toBe(
      "sk-or-real-value-123",
    );
  });

  it("leaves ${secret:<name>} placeholders intact when secretLookup is absent", () => {
    const result = resolveAgentProviderConfig({
      agent: getAgent("hermes"),
      foremanProvider: "openai",
      modelId: "gpt-4o-mini",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.envVars.OPENROUTER_API_KEY).toBe(
      "${secret:openrouter-key}",
    );
  });

  it("substitutes ${model} AND ${secret:…} in the same call", () => {
    const lookup = (name: string): string | null =>
      name === "openrouter-key" ? "sk-or-x" : null;
    const result = resolveAgentProviderConfig({
      agent: getAgent("hermes"),
      foremanProvider: "openai",
      modelId: "gpt-5-mini",
      secretLookup: lookup,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.configWrites["model.default"]).toBe(
      "openai/gpt-5-mini",
    );
    expect(result.config.envVars.OPENROUTER_API_KEY).toBe("sk-or-x");
  });
});

describe("resolveAgentProviderConfig — error paths", () => {
  it("returns no_mapping when agent has no provider_mapping", () => {
    // Use a generic-mcp-style stub agent — doesn't carry provider_mapping
    const stub: AgentEntry = {
      id: "generic-mcp",
      name: "Generic",
      tagline: "x",
      homepage: "https://example.com",
      install: { npm: "x", brew: null },
      config_paths: [],
      required_secrets: [],
      optional_secrets: [],
      mcp_compatible: true,
      supported_versions: ">=0.1.0",
      min_foreman_version: "0.1.2",
    } as unknown as AgentEntry;
    const result = resolveAgentProviderConfig({
      agent: stub,
      foremanProvider: "openai",
      modelId: "gpt-4o-mini",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("no_mapping");
  });

  it("returns unsupported_provider with the list of available providers", () => {
    const result = resolveAgentProviderConfig({
      agent: getAgent("claude-code"),
      foremanProvider: "openai", // Claude Code only maps anthropic
      modelId: "gpt-4o-mini",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unsupported_provider");
    if (result.error.kind !== "unsupported_provider") return;
    expect(result.error.availableProviders).toContain("anthropic");
  });

  it("returns unknown_variant when variantOverride points at a missing variant", () => {
    const result = resolveAgentProviderConfig({
      agent: getAgent("openclaw"),
      foremanProvider: "openai",
      modelId: "gpt-4o-mini",
      variantOverride: "ghost-variant-that-doesnt-exist",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unknown_variant");
    if (result.error.kind !== "unknown_variant") return;
    expect(result.error.available).toContain("native");
  });

  it("returns missing_secret when required_secret isn't in the store (lookup returns null)", () => {
    const lookup = (_name: string): string | null => null; // empty store
    const result = resolveAgentProviderConfig({
      agent: getAgent("hermes"),
      foremanProvider: "openai",
      modelId: "gpt-4o-mini",
      secretLookup: lookup,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("missing_secret");
    if (result.error.kind !== "missing_secret") return;
    expect(result.error.secretName).toBe("openrouter-key");
    expect(result.error.acquisition?.url).toBe("https://openrouter.ai/keys");
  });

  it("does NOT return missing_secret when variant has required_secret: null (OAuth path)", () => {
    const lookup = (_name: string): string | null => null;
    const result = resolveAgentProviderConfig({
      agent: getAgent("codex"),
      foremanProvider: "openai",
      modelId: "gpt-4o-mini",
      secretLookup: lookup,
    });
    // Codex OAuth variant has required_secret: null — so empty store is OK.
    expect(result.ok).toBe(true);
  });
});

describe("describeResolveError", () => {
  it("formats each error kind into a human-readable line", () => {
    expect(
      describeResolveError({ kind: "no_mapping", agentId: "weird-agent" }),
    ).toContain("weird-agent");
    expect(
      describeResolveError({
        kind: "unsupported_provider",
        foremanProvider: "cohere",
        availableProviders: ["openai", "anthropic"],
      }),
    ).toContain("cohere");
    expect(
      describeResolveError({
        kind: "unknown_variant",
        variantId: "x",
        available: ["a", "b"],
      }),
    ).toContain('"x"');
    expect(
      describeResolveError({
        kind: "missing_secret",
        secretName: "openrouter-key",
        acquisition: null,
      }),
    ).toContain("openrouter-key");
  });
});

describe("deriveDefaultModelId (#419 — data-driven)", () => {
  it("reads the default model from registry/providers.json", () => {
    // Defaults populated in PR fix/419 — registry edit, no TS change
    expect(deriveDefaultModelId("openai")).toBe("gpt-4o-mini");
    expect(deriveDefaultModelId("anthropic")).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(deriveDefaultModelId("gemini")).toBe("gemini-2.0-flash");
    expect(deriveDefaultModelId("ollama")).toBe("llama3.2");
  });

  it("returns 'default' for an unknown provider (safe fallback)", () => {
    expect(deriveDefaultModelId("cohere")).toBe("default");
  });

  it("returns 'default' for a provider that declares no default_model", () => {
    // openai-compatible is custom-endpoint — no sensible default model
    expect(deriveDefaultModelId("openai-compatible")).toBe("default");
  });
});
