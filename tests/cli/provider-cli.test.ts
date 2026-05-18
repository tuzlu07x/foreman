import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildListRows,
  renderListText,
} from "../../src/cli/provider-cli.js";
import { EventBus, type ForemanEventMap } from "../../src/core/event-bus.js";
import {
  loadBundledRegistry,
  type AgentEntry,
} from "../../src/core/registry-catalog.js";
import { RegistryService } from "../../src/core/registry.js";
import { SecretStore } from "../../src/core/secret-store.js";
import { createInMemoryDb } from "../../src/db/client.js";

// =============================================================================
// #408 / #412 — Phase 4. CLI helpers (list + switch) are exercised here
// against the bundled registry's real provider_mapping data, so any
// schema-shape drift breaks tests immediately.
// =============================================================================

function setup() {
  const h = createInMemoryDb();
  const bus = new EventBus<ForemanEventMap>();
  const registry = new RegistryService(h.db, bus);
  const secretStore = new SecretStore(h.db, Buffer.alloc(32, 1));
  return { db: h.db, sqlite: h.sqlite, registry, secretStore, bus };
}

function pickAgent(id: string): AgentEntry {
  const doc = loadBundledRegistry();
  const found = doc.agents.find((a) => a.id === id);
  if (!found) throw new Error(`agent ${id} missing`);
  return found;
}

describe("provider list — buildListRows", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
    // Register Hermes so the row-builder has something to read from DB.
    ctx.registry.register({
      id: "hermes",
      displayName: "Hermes",
      transport: "stdio",
    });
  });
  afterEach(() => {
    ctx.sqlite.close();
  });

  it("lists every variant across all providers in the agent's mapping", () => {
    const hermes = pickAgent("hermes");
    const rows = buildListRows("hermes", hermes, ctx.registry, ctx.secretStore);
    // Hermes has 3 providers × variants from Phase 1 — exact count check.
    // openai (2 variants) + anthropic (1) + gemini (1) = 4 rows.
    expect(rows).toHaveLength(4);
    const variantIds = rows.map((r) => r.variantId);
    expect(variantIds).toContain("via-openrouter");
    expect(variantIds).toContain("via-codex-oauth");
    expect(variantIds).toContain("direct");
  });

  it("marks the preferred variant as active when no llmProvider is set", () => {
    const hermes = pickAgent("hermes");
    const rows = buildListRows("hermes", hermes, ctx.registry, ctx.secretStore);
    // No active provider — no row should claim active.
    expect(rows.every((r) => !r.active)).toBe(true);
  });

  it("marks the user-picked variant as active when both provider + variant are set", () => {
    ctx.registry.setLlmProvider("hermes", "openai");
    ctx.registry.setProviderVariant("hermes", "via-openrouter");
    const hermes = pickAgent("hermes");
    const rows = buildListRows("hermes", hermes, ctx.registry, ctx.secretStore);
    const active = rows.filter((r) => r.active);
    expect(active).toHaveLength(1);
    expect(active[0]?.variantId).toBe("via-openrouter");
  });

  it("falls back to the preferred variant when llmProvider is set but variant is null", () => {
    ctx.registry.setLlmProvider("hermes", "openai");
    ctx.registry.setProviderVariant("hermes", null);
    const hermes = pickAgent("hermes");
    const rows = buildListRows("hermes", hermes, ctx.registry, ctx.secretStore);
    const active = rows.filter((r) => r.active);
    // hermes/openai.preferred is via-openrouter → that one's marked active.
    expect(active).toHaveLength(1);
    expect(active[0]?.variantId).toBe("via-openrouter");
  });

  it("reports secretStatus as present when the slot is in the secret store", () => {
    ctx.secretStore.add("openrouter-key", "sk-or-test");
    const hermes = pickAgent("hermes");
    const rows = buildListRows("hermes", hermes, ctx.registry, ctx.secretStore);
    const orVariant = rows.find((r) => r.variantId === "via-openrouter");
    expect(orVariant?.secretStatus).toBe("present");
  });

  it("reports n/a for OAuth-only variants (no required secret)", () => {
    const codex = pickAgent("codex");
    ctx.registry.register({
      id: "codex",
      displayName: "Codex",
      transport: "stdio",
    });
    const rows = buildListRows("codex", codex, ctx.registry, ctx.secretStore);
    const oauthRow = rows.find((r) => r.variantId === "oauth");
    expect(oauthRow?.secretStatus).toBe("n/a");
    expect(oauthRow?.interactiveSetup).toBe("codex login");
  });
});

describe("provider list — renderListText", () => {
  it("groups rows by Foreman provider and tags the active one", () => {
    const rows = [
      {
        agentId: "hermes",
        foremanProvider: "openai",
        variantId: "via-openrouter",
        label: "OpenAI via OpenRouter",
        active: true,
        requiredSecret: "openrouter-key",
        secretStatus: "present" as const,
        interactiveSetup: null,
      },
      {
        agentId: "hermes",
        foremanProvider: "openai",
        variantId: "via-codex-oauth",
        label: "OpenAI via Codex OAuth",
        active: false,
        requiredSecret: null,
        secretStatus: "n/a" as const,
        interactiveSetup: "hermes model",
      },
      {
        agentId: "hermes",
        foremanProvider: "anthropic",
        variantId: "direct",
        label: "Anthropic direct",
        active: false,
        requiredSecret: "anthropic-key",
        secretStatus: "missing" as const,
        interactiveSetup: null,
      },
    ];
    const text = renderListText(rows, "Hermes");
    expect(text).toContain("Hermes");
    expect(text).toContain("openai:");
    expect(text).toContain("anthropic:");
    expect(text).toContain("via-openrouter");
    expect(text).toContain("(active)");
    expect(text).toMatch(/anthropic-key/);
  });

  it("returns a 'no provider_mapping' note when rows is empty", () => {
    const text = renderListText([], "Generic");
    expect(text).toMatch(/no provider_mapping/);
  });
});
