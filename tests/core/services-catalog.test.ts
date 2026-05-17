import { describe, expect, it } from "vitest";
import {
  findService,
  loadActiveServices,
  loadBundledRegistry,
  loadBundledServices,
  parseServiceCatalogText,
  ServiceCatalogValidationError,
  ServiceNotInCatalogError,
  validateServicesAgainstAgents,
  type ServiceCatalog,
  type RegistryDoc,
} from "../../src/core/registry-catalog.js";

function freshService(): Record<string, unknown> {
  return {
    id: "telegram",
    name: "Telegram",
    description: "Bot integration",
    secret_name: "telegram-bot-token",
    where_to_get: "https://t.me/BotFather",
    format_hint: "123456789:ABC...",
    setup_steps: ["Step one", "Step two"],
    used_by_agents: ["hermes"],
    open_url_hotkey: true,
    extra_secrets: [],
  };
}

function validDoc(): Record<string, unknown> {
  return { version: 1, services: [freshService()] };
}

describe("parseServiceCatalogText", () => {
  it("accepts a well-formed document and returns the typed shape", () => {
    const doc = parseServiceCatalogText(JSON.stringify(validDoc()));
    expect(doc.services).toHaveLength(1);
    expect(doc.services[0]?.id).toBe("telegram");
  });

  it("rejects invalid JSON with ServiceCatalogValidationError", () => {
    expect(() => parseServiceCatalogText("{ not json")).toThrow(
      ServiceCatalogValidationError,
    );
  });

  it("rejects a missing version field", () => {
    const bad = { services: [freshService()] };
    expect(() => parseServiceCatalogText(JSON.stringify(bad))).toThrow(
      ServiceCatalogValidationError,
    );
  });

  it("rejects a non-kebab-case id", () => {
    const bad = validDoc();
    (bad.services as Record<string, unknown>[])[0]!.id = "Bad_ID";
    expect(() => parseServiceCatalogText(JSON.stringify(bad))).toThrow(
      ServiceCatalogValidationError,
    );
  });

  it("rejects when where_to_get is not a URL", () => {
    const bad = validDoc();
    (bad.services as Record<string, unknown>[])[0]!.where_to_get = "not a url";
    expect(() => parseServiceCatalogText(JSON.stringify(bad))).toThrow(
      ServiceCatalogValidationError,
    );
  });

  it("rejects when setup_steps is empty", () => {
    const bad = validDoc();
    (bad.services as Record<string, unknown>[])[0]!.setup_steps = [];
    expect(() => parseServiceCatalogText(JSON.stringify(bad))).toThrow(
      ServiceCatalogValidationError,
    );
  });

  it("accepts unknown fields on a service entry (forward-compat)", () => {
    const extra = { ...freshService(), oauth_redirect_uri: "https://x.y/cb" };
    const doc = parseServiceCatalogText(
      JSON.stringify({ version: 1, services: [extra] }),
    );
    expect(doc.services[0]?.id).toBe("telegram");
  });

  it("accepts empty used_by_agents (no installed agents using this yet)", () => {
    const orphan = { ...freshService(), id: "notion", used_by_agents: [] };
    const doc = parseServiceCatalogText(
      JSON.stringify({ version: 1, services: [orphan] }),
    );
    expect(doc.services[0]?.used_by_agents).toEqual([]);
  });
});

describe("findService", () => {
  it("returns the matching entry", () => {
    const doc = parseServiceCatalogText(JSON.stringify(validDoc()));
    expect(findService(doc, "telegram").name).toBe("Telegram");
  });

  it("throws ServiceNotInCatalogError for unknown id", () => {
    const doc = parseServiceCatalogText(JSON.stringify(validDoc()));
    expect(() => findService(doc, "missing")).toThrow(
      ServiceNotInCatalogError,
    );
  });
});

describe("loadBundledServices + loadActiveServices", () => {
  it("parses the bundled registry/services.json", () => {
    const doc = loadBundledServices();
    expect(doc.version).toBe(1);
    expect(doc.services.length).toBeGreaterThan(0);
  });

  it("includes the six tier-1 services", () => {
    const doc = loadBundledServices();
    const ids = doc.services.map((s) => s.id);
    expect(ids).toContain("telegram");
    expect(ids).toContain("discord");
    expect(ids).toContain("slack");
    expect(ids).toContain("github");
    expect(ids).toContain("atlassian");
    expect(ids).toContain("notion");
  });

  it("every service has at least one setup_step", () => {
    const doc = loadBundledServices();
    for (const service of doc.services) {
      expect(service.setup_steps.length).toBeGreaterThan(0);
    }
  });

  it("loadActiveServices reports the source as bundled", () => {
    const result = loadActiveServices();
    expect(result.source).toBe("bundled");
    expect(result.doc.services.length).toBeGreaterThan(0);
  });
});

describe("validateServicesAgainstAgents", () => {
  function makeServices(usedBy: string[][]): ServiceCatalog {
    return {
      version: 1,
      services: usedBy.map((agents, i) => ({
        id: `svc-${i}`,
        name: `Service ${i}`,
        description: "x",
        secret_name: `svc-${i}-token`,
        where_to_get: "https://example.com",
        format_hint: "x",
        setup_steps: ["one"],
        used_by_agents: agents,
        open_url_hotkey: false,
        extra_secrets: [],
      })),
    };
  }

  function makeAgents(ids: string[]): RegistryDoc {
    return {
      version: 1,
      agents: ids.map((id) => ({
        id,
        name: id,
        tagline: "x",
        homepage: "https://example.com/",
        install: { npm: id, brew: null },
        config_paths: ["~/.x/config.yaml"],
        required_secrets: [],
        optional_secrets: [],
        mcp_compatible: true,
        supported_versions: ">=1.0.0",
        min_foreman_version: "0.1.2",
      })),
    };
  }

  it("returns ok when every used_by_agents id exists in the agent catalog", () => {
    const result = validateServicesAgainstAgents(
      makeServices([["hermes", "openclaw"], ["claude-code"]]),
      makeAgents(["hermes", "openclaw", "claude-code"]),
    );
    expect(result.ok).toBe(true);
  });

  it("returns ok when used_by_agents is empty", () => {
    const result = validateServicesAgainstAgents(
      makeServices([[]]),
      makeAgents(["hermes"]),
    );
    expect(result.ok).toBe(true);
  });

  it("reports missing agents with service ids attached", () => {
    const result = validateServicesAgainstAgents(
      makeServices([["hermes", "ghost-agent"], ["claude-code", "missing"]]),
      makeAgents(["hermes", "claude-code"]),
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.missing).toEqual([
        { service: "svc-0", agent: "ghost-agent" },
        { service: "svc-1", agent: "missing" },
      ]);
    }
  });

  it("the bundled services + agents cross-validate cleanly", () => {
    const services = loadBundledServices();
    const agents = loadBundledRegistry();
    const result = validateServicesAgainstAgents(services, agents);
    expect(result.ok).toBe(true);
  });
});
