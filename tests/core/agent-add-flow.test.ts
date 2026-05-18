import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentAlreadyRegisteredError,
  checkSecrets,
  expandHome,
  pickConfigPath,
  providerOwningSecret,
  registerAgent,
} from "../../src/core/agent-add-flow.js";
import { EventBus, type ForemanEventMap } from "../../src/core/event-bus.js";
import { RegistryService } from "../../src/core/registry.js";
import { SecretStore } from "../../src/core/secret-store.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";
import { generateMasterKey } from "../../src/identity/encryption.js";
import type {
  AgentEntry,
  ProviderEntry,
} from "../../src/core/registry-catalog.js";

const FAKE_PROVIDER_CATALOG: ProviderEntry[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude",
    secret_name: "anthropic-key",
    key_prefix: "sk-ant-",
    where_to_get: "https://console.anthropic.com",
    format_hint: "starts with sk-ant-",
    instructions: [],
    endpoint_default: null,
    endpoint_required: false,
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "GPT",
    secret_name: "openai-key",
    key_prefix: "sk-",
    where_to_get: "https://platform.openai.com",
    format_hint: "starts with sk-",
    instructions: [],
    endpoint_default: null,
    endpoint_required: false,
  },
  {
    id: "gemini",
    name: "Google Gemini",
    description: "Gemini",
    secret_name: "gemini-key",
    key_prefix: "AIza",
    where_to_get: "https://aistudio.google.com",
    format_hint: "starts with AIza",
    instructions: [],
    endpoint_default: null,
    endpoint_required: false,
  },
];

function makeEntry(overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    id: "hermes",
    name: "Hermes",
    tagline: "Personal assistant",
    homepage: "https://example.com/",
    install: { npm: "hermes-agent", brew: null },
    config_paths: ["~/.hermes/config.yaml"],
    config_snippet: null,
    required_secrets: ["anthropic-key"],
    optional_secrets: ["openai-key"],
    mcp_compatible: true,
    supported_versions: ">=2.0.0",
    min_foreman_version: "0.1.2",
    ...overrides,
  };
}

describe("expandHome", () => {
  it("expands a leading ~/", () => {
    expect(expandHome("~/foo/bar")).not.toBe("~/foo/bar");
    expect(expandHome("~/foo/bar").endsWith("/foo/bar")).toBe(true);
  });

  it("expands a bare ~", () => {
    expect(expandHome("~")).not.toBe("~");
  });

  it("leaves absolute paths untouched", () => {
    expect(expandHome("/var/foo")).toBe("/var/foo");
  });
});

describe("checkSecrets", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let store: SecretStore;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    store = new SecretStore(db, generateMasterKey());
  });

  afterEach(() => {
    sqlite.close();
  });

  it("reports hasAllRequired=false when a required secret is missing", () => {
    const result = checkSecrets(makeEntry(), store);
    expect(result.hasAllRequired).toBe(false);
    expect(result.required[0]).toEqual({
      name: "anthropic-key",
      present: false,
    });
    expect(result.optional[0]).toEqual({ name: "openai-key", present: false });
  });

  it("reports hasAllRequired=true once the required secret is in the store", () => {
    store.add("anthropic-key", "sk-1");
    const result = checkSecrets(makeEntry(), store);
    expect(result.hasAllRequired).toBe(true);
    expect(result.required[0]?.present).toBe(true);
  });

  // #373 — drop cross-provider required_secrets when user picks a specific
  // LLM provider for this agent. Round-3 user picked OpenAI for OpenClaw,
  // Foreman still warned about anthropic-key because checkSecrets was
  // provider-blind.
  describe("with llmProvider filter (#373)", () => {
    it("drops anthropic-key when user picked openai for the agent", () => {
      const result = checkSecrets(
        makeEntry({ required_secrets: ["anthropic-key"] }),
        store,
        { llmProvider: "openai", providerCatalog: FAKE_PROVIDER_CATALOG },
      );
      expect(result.required).toEqual([]);
      expect(result.hasAllRequired).toBe(true);
    });

    it("keeps anthropic-key when user picked anthropic", () => {
      const result = checkSecrets(
        makeEntry({ required_secrets: ["anthropic-key"] }),
        store,
        { llmProvider: "anthropic", providerCatalog: FAKE_PROVIDER_CATALOG },
      );
      expect(result.required).toEqual([
        { name: "anthropic-key", present: false },
      ]);
      expect(result.hasAllRequired).toBe(false);
    });

    it("keeps non-provider keys (telegram-bot-token) regardless of llmProvider", () => {
      const result = checkSecrets(
        makeEntry({ required_secrets: ["telegram-bot-token"] }),
        store,
        { llmProvider: "openai", providerCatalog: FAKE_PROVIDER_CATALOG },
      );
      expect(result.required).toEqual([
        { name: "telegram-bot-token", present: false },
      ]);
    });

    it("filters a mixed list — drops cross-provider, keeps non-provider + matching", () => {
      const result = checkSecrets(
        makeEntry({
          required_secrets: [
            "anthropic-key",
            "telegram-bot-token",
            "openai-key",
          ],
        }),
        store,
        { llmProvider: "openai", providerCatalog: FAKE_PROVIDER_CATALOG },
      );
      expect(result.required.map((r) => r.name)).toEqual([
        "telegram-bot-token",
        "openai-key",
      ]);
    });

    it("no filter applied when llmProvider is omitted (backward compat)", () => {
      const result = checkSecrets(
        makeEntry({ required_secrets: ["anthropic-key"] }),
        store,
        { providerCatalog: FAKE_PROVIDER_CATALOG },
      );
      expect(result.required.map((r) => r.name)).toEqual(["anthropic-key"]);
    });

    it("no filter applied when providerCatalog is omitted (backward compat)", () => {
      const result = checkSecrets(
        makeEntry({ required_secrets: ["anthropic-key"] }),
        store,
        { llmProvider: "openai" },
      );
      expect(result.required.map((r) => r.name)).toEqual(["anthropic-key"]);
    });

    it("matches store presence correctly after filter", () => {
      store.add("openai-key", "sk-1");
      const result = checkSecrets(
        makeEntry({ required_secrets: ["anthropic-key", "openai-key"] }),
        store,
        { llmProvider: "openai", providerCatalog: FAKE_PROVIDER_CATALOG },
      );
      // anthropic-key filtered out; openai-key remains + is present
      expect(result.required).toEqual([
        { name: "openai-key", present: true },
      ]);
      expect(result.hasAllRequired).toBe(true);
    });
  });
});

describe("providerOwningSecret", () => {
  it("returns the provider id for a provider-owned secret", () => {
    expect(
      providerOwningSecret("anthropic-key", FAKE_PROVIDER_CATALOG),
    ).toBe("anthropic");
    expect(
      providerOwningSecret("openai-key", FAKE_PROVIDER_CATALOG),
    ).toBe("openai");
    expect(
      providerOwningSecret("gemini-key", FAKE_PROVIDER_CATALOG),
    ).toBe("gemini");
  });

  it("returns null for non-provider secrets (Telegram bot token etc.)", () => {
    expect(
      providerOwningSecret("telegram-bot-token", FAKE_PROVIDER_CATALOG),
    ).toBeNull();
    expect(
      providerOwningSecret("discord-bot-token", FAKE_PROVIDER_CATALOG),
    ).toBeNull();
  });

  it("returns null for unknown secrets", () => {
    expect(
      providerOwningSecret("nonexistent-key", FAKE_PROVIDER_CATALOG),
    ).toBeNull();
  });
});

describe("pickConfigPath", () => {
  it("returns the first declared config path expanded when none exist on disk", () => {
    const picked = pickConfigPath(
      makeEntry({ config_paths: ["~/.thing/config.yaml"] }),
    );
    expect(picked?.endsWith("/.thing/config.yaml")).toBe(true);
  });

  it("returns null when the entry has no config paths (generic-mcp)", () => {
    expect(pickConfigPath(makeEntry({ config_paths: [] }))).toBeNull();
  });
});

describe("registerAgent", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let registry: RegistryService;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    registry = new RegistryService(db, new EventBus<ForemanEventMap>());
  });

  afterEach(() => {
    sqlite.close();
  });

  it("inserts the agent with registry metadata and returns a private key", () => {
    const result = registerAgent({
      agentId: "hermes",
      entry: makeEntry(),
      registry,
    });
    expect(result.privateKey.length).toBe(32);
    const stored = registry.get("hermes");
    expect(stored?.displayName).toBe("Hermes");
    expect(stored?.metadata).toEqual({
      registryId: "hermes",
      registryHomepage: "https://example.com/",
    });
  });

  it("throws AgentAlreadyRegisteredError on second call with the same id", () => {
    registerAgent({ agentId: "hermes", entry: makeEntry(), registry });
    expect(() =>
      registerAgent({ agentId: "hermes", entry: makeEntry(), registry }),
    ).toThrow(AgentAlreadyRegisteredError);
  });
});
