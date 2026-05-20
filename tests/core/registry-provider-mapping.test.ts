import { describe, expect, it } from "vitest";
import {
  AgentEntrySchema,
  loadBundledRegistry,
} from "../../src/core/registry-catalog.js";

// =============================================================================
// #408 / #409 — Phase 1 of the per-agent provider mapping epic.
// Validates that the new `provider_mapping` zod schema accepts well-formed
// shapes and that every shipped agent's mapping parses correctly.
// =============================================================================

function baseAgent(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "test-agent",
    name: "Test",
    tagline: "test",
    homepage: "https://example.com",
    install: { npm: "test", brew: null },
    config_paths: ["~/.test/config.json"],
    required_secrets: [],
    optional_secrets: [],
    mcp_compatible: true,
    supported_versions: ">=0.1.0",
    min_foreman_version: "0.1.2",
    ...overrides,
  };
}

describe("AgentEntrySchema — provider_mapping (#408 phase 1)", () => {
  it("accepts a complete provider_mapping block with all variant fields", () => {
    const entry = baseAgent({
      provider_mapping: {
        openai: {
          preferred: "via-openrouter",
          variants: {
            "via-openrouter": {
              label: "OpenAI via OpenRouter",
              writes: { "model.provider": "openrouter" },
              env_vars: { OPENROUTER_API_KEY: "${secret:openrouter-key}" },
              required_secret: "openrouter-key",
              secret_acquisition: {
                name: "OpenRouter API key",
                url: "https://openrouter.ai/keys",
                note: "Get one here.",
              },
            },
            "via-codex-oauth": {
              label: "OpenAI via Codex OAuth",
              writes: { "model.provider": "codex" },
              interactive_setup: "codex login",
              post_setup_verify: "codex login status",
              required_secret: null,
            },
          },
        },
      },
    });
    const parsed = AgentEntrySchema.parse(entry);
    expect(parsed.provider_mapping?.openai?.preferred).toBe("via-openrouter");
    expect(
      parsed.provider_mapping?.openai?.variants["via-openrouter"]?.required_secret,
    ).toBe("openrouter-key");
  });

  it("accepts toml_writes + auth_json_writes for TOML-based agents", () => {
    const entry = baseAgent({
      provider_mapping: {
        openai: {
          preferred: "api-key",
          variants: {
            "api-key": {
              label: "API key",
              toml_writes: [
                {
                  path: "~/.test/config.toml",
                  key: "preferred_auth_method",
                  value: "apikey",
                },
              ],
              auth_json_writes: {
                path: "~/.test/auth.json",
                key: "OPENAI_API_KEY",
                value: "${secret:openai-key}",
              },
              required_secret: "openai-key",
            },
          },
        },
      },
    });
    const parsed = AgentEntrySchema.parse(entry);
    expect(
      parsed.provider_mapping?.openai?.variants["api-key"]?.toml_writes,
    ).toHaveLength(1);
    expect(
      parsed.provider_mapping?.openai?.variants["api-key"]?.auth_json_writes
        ?.key,
    ).toBe("OPENAI_API_KEY");
  });

  it("makes provider_mapping optional (agents without it still parse)", () => {
    const entry = baseAgent({}); // no provider_mapping
    expect(() => AgentEntrySchema.parse(entry)).not.toThrow();
  });

  it("rejects an empty variants object", () => {
    // zod's z.record accepts empty maps by default — this test documents the
    // current behaviour. A future refinement could require at least 1 variant.
    const entry = baseAgent({
      provider_mapping: {
        openai: {
          preferred: "x",
          variants: {},
        },
      },
    });
    // Empty variants parse OK at schema level; the resolver (Phase 2) is what
    // catches the missing-variant runtime error.
    expect(() => AgentEntrySchema.parse(entry)).not.toThrow();
  });

  it("rejects a malformed url in secret_acquisition", () => {
    const entry = baseAgent({
      provider_mapping: {
        openai: {
          preferred: "x",
          variants: {
            x: {
              label: "x",
              secret_acquisition: {
                name: "X",
                url: "not-a-url",
              },
            },
          },
        },
      },
    });
    expect(() => AgentEntrySchema.parse(entry)).toThrow();
  });

  it("requires label as a non-empty string for every variant", () => {
    const entry = baseAgent({
      provider_mapping: {
        openai: {
          preferred: "x",
          variants: {
            x: { label: "" },
          },
        },
      },
    });
    expect(() => AgentEntrySchema.parse(entry)).toThrow();
  });
});

describe("Bundled registry — each shipped agent's provider_mapping (#408 phase 1)", () => {
  it("loads the bundled registry without schema errors", () => {
    const doc = loadBundledRegistry();
    expect(doc.agents.length).toBeGreaterThan(0);
  });

  it("Hermes maps openai → via-openrouter as preferred, with openrouter-key", () => {
    const doc = loadBundledRegistry();
    const hermes = doc.agents.find((a) => a.id === "hermes");
    expect(hermes?.provider_mapping?.openai?.preferred).toBe("via-openrouter");
    expect(
      hermes?.provider_mapping?.openai?.variants["via-openrouter"]
        ?.required_secret,
    ).toBe("openrouter-key");
    expect(
      hermes?.provider_mapping?.openai?.variants["via-openrouter"]?.env_vars
        ?.OPENROUTER_API_KEY,
    ).toContain("openrouter-key");
  });

  it("Hermes also offers the via-codex-oauth variant (no required secret)", () => {
    const doc = loadBundledRegistry();
    const hermes = doc.agents.find((a) => a.id === "hermes");
    const oauth =
      hermes?.provider_mapping?.openai?.variants["via-codex-oauth"];
    expect(oauth).toBeDefined();
    // QA round 6: this variant explicitly sets required_secret: null
    // (not undefined) because the picker auto-skip logic + secret
    // checks key on `required_secret === null` semantics.
    expect(oauth?.required_secret).toBeNull();
    // Hermes runs its OWN OAuth for the OpenAI-Codex provider; it does
    // NOT read Codex CLI's auth.json. The interactive_setup IS the auth.
    expect(oauth?.interactive_setup).toBe(
      "hermes auth add openai-codex --type oauth",
    );
    expect(oauth?.writes?.["model.provider"]).toBe("openai-codex");
  });

  it("Hermes anthropic + gemini variants use native provider strings", () => {
    const doc = loadBundledRegistry();
    const hermes = doc.agents.find((a) => a.id === "hermes");
    expect(
      hermes?.provider_mapping?.anthropic?.variants.direct?.writes?.[
        "model.provider"
      ],
    ).toBe("anthropic");
    expect(
      hermes?.provider_mapping?.gemini?.variants.direct?.writes?.[
        "model.provider"
      ],
    ).toBe("google");
  });

  it("OpenClaw maps openai → native with slash-form model + OPENAI_API_KEY env", () => {
    const doc = loadBundledRegistry();
    const openclaw = doc.agents.find((a) => a.id === "openclaw");
    const variant = openclaw?.provider_mapping?.openai?.variants.native;
    expect(variant?.writes?.["agents.defaults.model.primary"]).toBe(
      "openai/${model}",
    );
    expect(variant?.env_vars?.OPENAI_API_KEY).toContain("openai-key");
  });

  it("Codex maps openai with OAuth as preferred variant (no required secret)", () => {
    const doc = loadBundledRegistry();
    const codex = doc.agents.find((a) => a.id === "codex");
    expect(codex?.provider_mapping?.openai?.preferred).toBe("oauth");
    const oauth = codex?.provider_mapping?.openai?.variants.oauth;
    expect(oauth?.interactive_setup).toBe("codex login");
    expect(oauth?.post_setup_verify).toBe("codex login status");
    expect(oauth?.required_secret).toBeNull();
  });

  it("Codex also offers the api-key variant with auth.json writes", () => {
    const doc = loadBundledRegistry();
    const codex = doc.agents.find((a) => a.id === "codex");
    const apiKey = codex?.provider_mapping?.openai?.variants["api-key"];
    expect(apiKey?.auth_json_writes?.key).toBe("OPENAI_API_KEY");
    expect(apiKey?.toml_writes?.[0]?.value).toBe("apikey");
    expect(apiKey?.required_secret).toBe("openai-key");
  });

  it("Claude Code maps anthropic with direct preferred + oauth alt", () => {
    const doc = loadBundledRegistry();
    const claudeCode = doc.agents.find((a) => a.id === "claude-code");
    expect(claudeCode?.provider_mapping?.anthropic?.preferred).toBe("direct");
    expect(
      claudeCode?.provider_mapping?.anthropic?.variants.direct?.required_secret,
    ).toBe("anthropic-key");
    expect(
      claudeCode?.provider_mapping?.anthropic?.variants.oauth?.interactive_setup,
    ).toBe("claude auth login");
  });

  it("ZeroClaw maps all three providers (openai, anthropic, gemini) with toml_writes", () => {
    const doc = loadBundledRegistry();
    const zeroclaw = doc.agents.find((a) => a.id === "zeroclaw");
    for (const provider of ["openai", "anthropic", "gemini"]) {
      const variant =
        zeroclaw?.provider_mapping?.[provider]?.variants.direct;
      expect(variant?.toml_writes).toHaveLength(2);
      expect(variant?.toml_writes?.[0]?.key).toBe("default_provider");
      expect(variant?.toml_writes?.[1]?.key).toBe("api_key");
    }
  });

  it("every variant with a required_secret also declares secret_acquisition", () => {
    // Discoverability check: if Foreman is going to ask the user for a key,
    // it must also tell them where to get it.
    const doc = loadBundledRegistry();
    const offenders: string[] = [];
    for (const agent of doc.agents) {
      if (!agent.provider_mapping) continue;
      for (const [provider, mapping] of Object.entries(
        agent.provider_mapping,
      )) {
        for (const [variantId, variant] of Object.entries(mapping.variants)) {
          if (variant.required_secret && !variant.secret_acquisition) {
            offenders.push(`${agent.id}/${provider}/${variantId}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
