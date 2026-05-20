import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isRequiredSetupComplete,
  resolveRequiredSetup,
  type RequiredSetupResolution,
} from "../../src/core/required-setup.js";
import {
  loadBundledRegistry,
  type AgentEntry,
} from "../../src/core/registry-catalog.js";
import { SecretStore } from "../../src/core/secret-store.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";

// =============================================================================
// #408 / #411 Phase 3 — required-setup aggregator. Combines per-agent
// resolver output across the user's full selection so the wizard can show
// one consolidated screen of "what we need before install".
// =============================================================================

function pickAgent(id: string): AgentEntry {
  const doc = loadBundledRegistry();
  const found = doc.agents.find((a) => a.id === id);
  if (!found) throw new Error(`agent ${id} missing`);
  return found;
}

describe("resolveRequiredSetup — bundled-registry scenarios", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let store: SecretStore;

  beforeEach(() => {
    const h = createInMemoryDb();
    db = h.db;
    sqlite = h.sqlite;
    store = new SecretStore(db, Buffer.alloc(32, 1));
  });
  afterEach(() => {
    sqlite.close();
  });

  it("Hermes + OpenClaw both on openai: 2 secrets needed (openrouter-key missing, openai-key missing)", () => {
    const res = resolveRequiredSetup({
      agents: [pickAgent("hermes"), pickAgent("openclaw")],
      agentProviders: { hermes: "openai", openclaw: "openai" },
      secretStore: store,
    });
    expect(res.errors).toEqual([]);
    expect(res.secrets).toHaveLength(2);
    const orKey = res.secrets.find((s) => s.slotName === "openrouter-key");
    const oaiKey = res.secrets.find((s) => s.slotName === "openai-key");
    expect(orKey?.agents).toEqual(["hermes"]);
    expect(orKey?.status).toBe("missing");
    expect(orKey?.acquisition?.url).toBe("https://openrouter.ai/keys");
    expect(oaiKey?.agents).toEqual(["openclaw"]);
    expect(oaiKey?.status).toBe("missing");
  });

  it("openai-key already present in store: status flips to 'present'", () => {
    store.add("openai-key", "sk-test");
    const res = resolveRequiredSetup({
      agents: [pickAgent("openclaw")],
      agentProviders: { openclaw: "openai" },
      secretStore: store,
    });
    expect(res.secrets[0]?.status).toBe("present");
  });

  it("Codex on openai: OAuth variant queues 'codex login', no secret required", () => {
    const res = resolveRequiredSetup({
      agents: [pickAgent("codex")],
      agentProviders: { codex: "openai" },
      secretStore: store,
    });
    expect(res.secrets).toEqual([]);
    expect(res.oauthSteps).toHaveLength(1);
    expect(res.oauthSteps[0]?.command).toBe("codex login");
    expect(res.oauthSteps[0]?.verify).toBe("codex login status");
    expect(res.oauthSteps[0]?.agentId).toBe("codex");
    // QA round 4 — when required_secret is null AND interactive_setup
    // is set, the interactive_setup IS the sole auth path so it MUST
    // be mandatory. Previously this was queued as optional, leaving
    // users able to skip past their own auth path.
    expect(res.oauthSteps[0]?.mandatory).toBe(true);
    expect(res.oauthSteps[0]?.reason?.toLowerCase()).toContain("codex login");
  });

  it("Hermes + OpenClaw + Codex on openai: 2 secrets + 1 oauth combined", () => {
    const res = resolveRequiredSetup({
      agents: [
        pickAgent("hermes"),
        pickAgent("openclaw"),
        pickAgent("codex"),
      ],
      agentProviders: {
        hermes: "openai",
        openclaw: "openai",
        codex: "openai",
      },
      secretStore: store,
    });
    expect(res.secrets).toHaveLength(2);
    expect(res.oauthSteps).toHaveLength(1);
    expect(res.errors).toEqual([]);
  });

  it("ZeroClaw + Hermes both on anthropic: anthropic-key bucket lists both agents", () => {
    const res = resolveRequiredSetup({
      agents: [pickAgent("zeroclaw"), pickAgent("hermes")],
      agentProviders: { zeroclaw: "anthropic", hermes: "anthropic" },
      secretStore: store,
    });
    const anthKey = res.secrets.find((s) => s.slotName === "anthropic-key");
    expect(anthKey?.agents).toHaveLength(2);
    expect(anthKey?.agents).toEqual(
      expect.arrayContaining(["zeroclaw", "hermes"]),
    );
  });

  it("agents without a provider pick are skipped silently", () => {
    const res = resolveRequiredSetup({
      agents: [pickAgent("hermes"), pickAgent("openclaw")],
      agentProviders: { hermes: "openai" }, // openclaw missing
      secretStore: store,
    });
    // Only Hermes' openrouter-key surfaces — OpenClaw didn't get analyzed.
    expect(res.secrets).toHaveLength(1);
    expect(res.secrets[0]?.slotName).toBe("openrouter-key");
  });

  it("unsupported provider records an error (Claude Code can't do openai)", () => {
    const res = resolveRequiredSetup({
      agents: [pickAgent("claude-code")],
      agentProviders: { "claude-code": "openai" }, // CC only maps anthropic
      secretStore: store,
    });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.agentId).toBe("claude-code");
    expect(res.errors[0]?.error).toMatch(/openai/);
  });

  it("sessionOverrides 'saved-in-session' beats missing status", () => {
    const res = resolveRequiredSetup({
      agents: [pickAgent("hermes")],
      agentProviders: { hermes: "openai" },
      secretStore: store,
      sessionOverrides: { "openrouter-key": "saved-in-session" },
    });
    expect(res.secrets[0]?.status).toBe("saved-in-session");
  });

  it("sessionOverrides 'skipped' records that decision", () => {
    const res = resolveRequiredSetup({
      agents: [pickAgent("hermes")],
      agentProviders: { hermes: "openai" },
      secretStore: store,
      sessionOverrides: { "openrouter-key": "skipped" },
    });
    expect(res.secrets[0]?.status).toBe("skipped");
  });

  // #449 — Resolver should carry the variant's `secret_acquisition.note`
  // through to the required-setup picker so the wizard can render it
  // inline (the user sees "Hermes routes OpenAI calls through
  // OpenRouter..." instead of guessing why an unrelated key is asked).
  it("Hermes/openai surfaces the OpenRouter explanation note (#449)", () => {
    const res = resolveRequiredSetup({
      agents: [pickAgent("hermes")],
      agentProviders: { hermes: "openai" },
      secretStore: store,
    });
    const orKey = res.secrets.find((s) => s.slotName === "openrouter-key");
    expect(orKey?.acquisition?.note).toBeDefined();
    expect(orKey?.acquisition?.note?.toLowerCase()).toContain("openrouter");
    expect(orKey?.acquisition?.note?.toLowerCase()).toContain("openai");
  });

  it("modelOverrides feed into resolver — picker (#405) integration point", () => {
    const res = resolveRequiredSetup({
      agents: [pickAgent("hermes")],
      agentProviders: { hermes: "openai" },
      secretStore: store,
      modelOverrides: { openai: "gpt-5.4" },
    });
    // The aggregator doesn't expose model id directly — it's used inside
    // the resolver call for ${model} substitution. We can't observe it
    // here without mocking the resolver, but the test asserts the option
    // is plumbed without throwing.
    expect(res.errors).toEqual([]);
  });

  // #450 — agentVariants override the registry's `preferred` variant
  // per agent. The required-secret bucket changes accordingly: e.g.
  // picking via-codex-oauth for Hermes/openai means no openrouter-key.
  it("agentVariants picks via-codex-oauth → no openrouter-key required (#450)", () => {
    const res = resolveRequiredSetup({
      agents: [pickAgent("hermes")],
      agentProviders: { hermes: "openai" },
      agentVariants: { hermes: "via-codex-oauth" },
      secretStore: store,
    });
    expect(res.errors).toEqual([]);
    const orKey = res.secrets.find((s) => s.slotName === "openrouter-key");
    expect(orKey).toBeUndefined();
  });

  // QA round 6: Hermes' via-codex-oauth was originally modeled as
  // piggybacking on Codex CLI's auth.json (depends_on_oauth → codex login).
  // That was wrong — Hermes runs its OWN OpenAI-Codex OAuth flow via
  // `hermes login --provider openai-codex` and reads its own token store
  // (NOT Codex CLI's). Mandatory step is the interactive_setup itself,
  // promoted by the sole-auth-path rule from earlier round.
  it("via-codex-oauth queues a MANDATORY hermes login step (sole-auth-path)", () => {
    const res = resolveRequiredSetup({
      agents: [pickAgent("hermes")],
      agentProviders: { hermes: "openai" },
      agentVariants: { hermes: "via-codex-oauth" },
      secretStore: store,
    });
    const mandatory = res.oauthSteps.find((o) => o.mandatory);
    expect(mandatory).toBeDefined();
    expect(mandatory?.command).toBe(
      "hermes login --provider openai-codex",
    );
    expect(mandatory?.verify).toBe("hermes auth status openai-codex");
    expect(mandatory?.agentId).toBe("hermes");
    expect(mandatory?.reason?.toLowerCase()).toContain("hermes");
  });

  it("default openrouter route does not queue any mandatory step (#461)", () => {
    const res = resolveRequiredSetup({
      agents: [pickAgent("hermes")],
      agentProviders: { hermes: "openai" },
      secretStore: store,
    });
    expect(res.oauthSteps.filter((o) => o.mandatory)).toHaveLength(0);
  });

  it("agentVariants default behavior (omitted) still picks the registry preferred", () => {
    const res = resolveRequiredSetup({
      agents: [pickAgent("hermes")],
      agentProviders: { hermes: "openai" },
      // agentVariants intentionally omitted
      secretStore: store,
    });
    expect(res.errors).toEqual([]);
    const orKey = res.secrets.find((s) => s.slotName === "openrouter-key");
    expect(orKey).toBeDefined();
    expect(orKey?.status).toBe("missing");
  });
});

describe("isRequiredSetupComplete", () => {
  it("true when no errors + no missing secrets", () => {
    const res: RequiredSetupResolution = {
      secrets: [
        {
          slotName: "openai-key",
          agents: ["openclaw"],
          acquisition: null,
          status: "present",
        },
      ],
      oauthSteps: [],
      errors: [],
    };
    expect(isRequiredSetupComplete(res)).toBe(true);
  });

  it("false when any secret is missing", () => {
    const res: RequiredSetupResolution = {
      secrets: [
        {
          slotName: "openrouter-key",
          agents: ["hermes"],
          acquisition: null,
          status: "missing",
        },
      ],
      oauthSteps: [],
      errors: [],
    };
    expect(isRequiredSetupComplete(res)).toBe(false);
  });

  it("false when there's a resolver error", () => {
    const res: RequiredSetupResolution = {
      secrets: [],
      oauthSteps: [],
      errors: [
        {
          agentId: "claude-code",
          foremanProvider: "openai",
          error: "unsupported",
        },
      ],
    };
    expect(isRequiredSetupComplete(res)).toBe(false);
  });

  it("true even when there are OAuth queue steps — those are post-install", () => {
    const res: RequiredSetupResolution = {
      secrets: [],
      oauthSteps: [
        {
          agentId: "codex",
          variantId: "oauth",
          command: "codex login",
          verify: "codex login status",
          acquisition: null,
          mandatory: false,
          reason: null,
        },
      ],
      errors: [],
    };
    expect(isRequiredSetupComplete(res)).toBe(true);
  });

  it("skipped secret still allows completion (user opted out)", () => {
    const res: RequiredSetupResolution = {
      secrets: [
        {
          slotName: "openrouter-key",
          agents: ["hermes"],
          acquisition: null,
          status: "skipped",
        },
      ],
      oauthSteps: [],
      errors: [],
    };
    // Skipped means user accepted that Hermes will fail at start.
    // The wizard surfaces a warning but lets them through.
    expect(isRequiredSetupComplete(res)).toBe(true);
  });
});
