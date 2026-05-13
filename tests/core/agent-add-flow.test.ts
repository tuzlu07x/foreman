import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentAlreadyRegisteredError,
  checkSecrets,
  expandHome,
  pickConfigPath,
  registerAgent,
} from "../../src/core/agent-add-flow.js";
import { EventBus, type ForemanEventMap } from "../../src/core/event-bus.js";
import { RegistryService } from "../../src/core/registry.js";
import { SecretStore } from "../../src/core/secret-store.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";
import { generateMasterKey } from "../../src/identity/encryption.js";
import type { AgentEntry } from "../../src/core/registry-catalog.js";

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
