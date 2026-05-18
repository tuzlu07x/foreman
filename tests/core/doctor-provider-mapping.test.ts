import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/cli/init.js";
import { checkProviderMapping } from "../../src/core/doctor.js";
import { bus } from "../../src/core/event-bus.js";
import { RegistryService } from "../../src/core/registry.js";
import { SecretStore } from "../../src/core/secret-store.js";
import { closeDb, getDb } from "../../src/db/client.js";
import { loadOrCreateSecretsMasterKey } from "../../src/identity/master-key.js";

// =============================================================================
// #408 / #412 — `foreman doctor` extension. Validates that every registered
// agent with provider_mapping has its required secret in place or its OAuth
// flow queued. Surfaces ✓ / ⚠ / ✗ per-agent with actionable remediation.
// =============================================================================

describe("checkProviderMapping", () => {
  let tmp: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "foreman-doctor-pm-"));
    previousHome = process.env.FOREMAN_HOME;
    process.env.FOREMAN_HOME = tmp;
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.FOREMAN_HOME;
    else process.env.FOREMAN_HOME = previousHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ok when no agents are registered (fresh init)", () => {
    runInit();
    const r = checkProviderMapping();
    expect(r.status).toBe("ok");
  });

  it("silently skips agents without an llmProvider (mid-setup state)", () => {
    runInit();
    const registry = new RegistryService(getDb(), bus);
    registry.register({
      id: "hermes",
      displayName: "Hermes",
      transport: "stdio",
    });
    // No llmProvider yet — expected to NOT surface as a warning.
    const r = checkProviderMapping();
    expect(r.status).toBe("ok");
    expect(r.message).not.toContain("hermes");
  });

  it("✓ when agent has llmProvider + required secret present", () => {
    runInit();
    const db = getDb();
    const registry = new RegistryService(db, bus);
    const secrets = new SecretStore(db, loadOrCreateSecretsMasterKey());
    registry.register({
      id: "hermes",
      displayName: "Hermes",
      transport: "stdio",
      llmProvider: "openai",
    });
    secrets.add("openrouter-key", "sk-or-real");
    const r = checkProviderMapping();
    expect(r.status).toBe("ok");
    expect(r.message).toContain("hermes");
    expect(r.message).toContain("via-openrouter");
    expect(r.message).toContain("openrouter-key present");
  });

  it("✗ when agent has llmProvider but required secret is missing", () => {
    runInit();
    const registry = new RegistryService(getDb(), bus);
    registry.register({
      id: "hermes",
      displayName: "Hermes",
      transport: "stdio",
      llmProvider: "openai",
    });
    // No openrouter-key in store.
    const r = checkProviderMapping();
    expect(r.status).toBe("fail");
    expect(r.message).toContain("hermes");
    expect(r.message).toContain("missing");
    expect(r.remediation).toContain("foreman secrets add openrouter-key");
  });

  it("⚠ when agent uses OAuth variant (we can't auto-verify OAuth completed)", () => {
    runInit();
    const registry = new RegistryService(getDb(), bus);
    registry.register({
      id: "codex",
      displayName: "Codex",
      transport: "stdio",
      llmProvider: "openai",
      // OAuth is the preferred variant for codex/openai → status: warn.
    });
    const r = checkProviderMapping();
    expect(r.status).toBe("warn");
    expect(r.message).toContain("codex");
    expect(r.message).toContain("OAuth");
    expect(r.message).toMatch(/codex login/);
  });

  it("✗ when provider isn't in the agent's mapping (e.g. claude-code/openai)", () => {
    runInit();
    const registry = new RegistryService(getDb(), bus);
    registry.register({
      id: "claude-code",
      displayName: "Claude Code",
      transport: "stdio",
      llmProvider: "openai", // CC only maps anthropic
    });
    const r = checkProviderMapping();
    expect(r.status).toBe("fail");
    expect(r.message).toContain("claude-code");
    expect(r.message).toMatch(/no mapping/);
    expect(r.remediation).toContain("foreman provider switch claude-code");
  });

  it("aggregates per-agent rows into one multi-line message", () => {
    runInit();
    const db = getDb();
    const registry = new RegistryService(db, bus);
    const secrets = new SecretStore(db, loadOrCreateSecretsMasterKey());
    registry.register({
      id: "hermes",
      displayName: "Hermes",
      transport: "stdio",
      llmProvider: "openai",
    });
    registry.register({
      id: "openclaw",
      displayName: "OpenClaw",
      transport: "stdio",
      llmProvider: "openai",
    });
    secrets.add("openai-key", "sk-test");
    // hermes will fail (no openrouter-key), openclaw will pass (openai-key present).
    const r = checkProviderMapping();
    expect(r.status).toBe("fail"); // any fail makes the whole check fail
    expect(r.message).toContain("hermes");
    expect(r.message).toContain("openclaw");
  });

  it("honors providerVariant override (api-key variant of Codex)", () => {
    runInit();
    const db = getDb();
    const registry = new RegistryService(db, bus);
    const secrets = new SecretStore(db, loadOrCreateSecretsMasterKey());
    registry.register({
      id: "codex",
      displayName: "Codex",
      transport: "stdio",
      llmProvider: "openai",
      providerVariant: "api-key", // user switched off OAuth
    });
    secrets.add("openai-key", "sk-test");
    const r = checkProviderMapping();
    expect(r.status).toBe("ok");
    expect(r.message).toContain("codex");
    expect(r.message).toContain("api-key");
    expect(r.message).toContain("openai-key present");
  });
});
