import { describe, expect, it } from "vitest";
import {
  loadBundledProviders,
  loadBundledRegistry,
  loadBundledServices,
  validateAgentsAgainstCatalogs,
  type CatalogCrossRefIssue,
  type ProviderCatalog,
  type RegistryDoc,
  type ServiceCatalog,
} from "../../src/core/registry-catalog.js";

function emptyProviders(): ProviderCatalog {
  return { version: 1, providers: [] };
}

function emptyServices(): ServiceCatalog {
  return { version: 1, services: [] };
}

function makeProviders(ids: string[]): ProviderCatalog {
  return {
    version: 1,
    providers: ids.map((id) => ({
      id,
      name: id,
      description: "x",
      secret_name: `${id}-key`,
      where_to_get: "https://example.com",
      format_hint: "x",
      instructions: ["x"],
      endpoint_default: null,
      endpoint_required: false,
    })),
  };
}

function makeServices(specs: { id: string; usedBy: string[] }[]): ServiceCatalog {
  return {
    version: 1,
    services: specs.map((s) => ({
      id: s.id,
      name: s.id,
      description: "x",
      secret_name: `${s.id}-token`,
      where_to_get: "https://example.com",
      format_hint: "x",
      setup_steps: ["x"],
      used_by_agents: s.usedBy,
      open_url_hotkey: false,
    })),
  };
}

function makeAgents(
  specs: { id: string; llmCompat?: string[]; optionalServices?: string[] }[],
): RegistryDoc {
  return {
    version: 1,
    agents: specs.map((spec) => ({
      id: spec.id,
      name: spec.id,
      tagline: "x",
      homepage: "https://example.com/",
      install: { npm: spec.id, brew: null },
      config_paths: ["~/.x/config.yaml"],
      required_secrets: [],
      optional_secrets: [],
      llm_compat: spec.llmCompat,
      optional_services: spec.optionalServices,
      mcp_compatible: true,
      supported_versions: "*",
      min_foreman_version: "0.1.2",
    })),
  };
}

describe("validateAgentsAgainstCatalogs", () => {
  it("returns ok when every reference resolves", () => {
    const result = validateAgentsAgainstCatalogs(
      makeAgents([
        { id: "hermes", llmCompat: ["anthropic"], optionalServices: ["telegram"] },
      ]),
      makeProviders(["anthropic"]),
      makeServices([{ id: "telegram", usedBy: ["hermes"] }]),
    );
    expect(result.ok).toBe(true);
  });

  it("flags an agent's llm_compat reference that has no matching provider", () => {
    const result = validateAgentsAgainstCatalogs(
      makeAgents([{ id: "hermes", llmCompat: ["ghost-provider"] }]),
      makeProviders(["anthropic"]),
      emptyServices(),
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.issues).toEqual<CatalogCrossRefIssue[]>([
        {
          source: "agent",
          sourceId: "hermes",
          field: "llm_compat",
          missing: "ghost-provider",
        },
      ]);
    }
  });

  it("flags an agent's optional_services reference that has no matching service", () => {
    const result = validateAgentsAgainstCatalogs(
      makeAgents([
        { id: "hermes", optionalServices: ["telegram", "ghost-service"] },
      ]),
      emptyProviders(),
      makeServices([{ id: "telegram", usedBy: ["hermes"] }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.missing).toBe("ghost-service");
    }
  });

  it("flags a service's used_by_agents reference that has no matching agent", () => {
    const result = validateAgentsAgainstCatalogs(
      makeAgents([{ id: "hermes" }]),
      emptyProviders(),
      makeServices([{ id: "telegram", usedBy: ["hermes", "ghost-agent"] }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.issues).toEqual<CatalogCrossRefIssue[]>([
        {
          source: "service",
          sourceId: "telegram",
          field: "used_by_agents",
          missing: "ghost-agent",
        },
      ]);
    }
  });

  it("collects all issues across multiple agents and services", () => {
    const result = validateAgentsAgainstCatalogs(
      makeAgents([
        { id: "a", llmCompat: ["missing-provider"] },
        { id: "b", optionalServices: ["missing-service"] },
      ]),
      makeProviders(["other-provider"]),
      makeServices([{ id: "x", usedBy: ["missing-agent"] }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.issues).toHaveLength(3);
    }
  });

  it("treats missing optional fields as empty (no false positives)", () => {
    const result = validateAgentsAgainstCatalogs(
      makeAgents([{ id: "legacy" }]),
      emptyProviders(),
      emptyServices(),
    );
    expect(result.ok).toBe(true);
  });

  it("the bundled three catalogs cross-validate cleanly", () => {
    const agents = loadBundledRegistry();
    const providers = loadBundledProviders();
    const services = loadBundledServices();
    const result = validateAgentsAgainstCatalogs(agents, providers, services);
    if (result.ok === false) {
      console.error("Bundled catalog cross-ref issues:", result.issues);
    }
    expect(result.ok).toBe(true);
  });
});
