import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/cli/init.js";
import { checkProviderMapping, runRouteVerify } from "../../src/core/doctor.js";
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

  describe("an OAuth route: its registry verify command decides", () => {
    const registerOAuth = (): void => {
      runInit();
      const registry = new RegistryService(getDb(), bus);
      // OAuth is the preferred variant for codex/openai.
      registry.register({ id: "codex", displayName: "Codex", transport: "stdio", llmProvider: "openai" });
      registry.register({
        id: "claude-code",
        displayName: "Claude Code",
        transport: "stdio",
        llmProvider: "anthropic",
        providerVariant: "oauth",
      });
    };

    it("✓ right after a sign-in: the verify commands pass", () => {
      registerOAuth();
      const ran: string[] = [];
      const r = checkProviderMapping({
        verify: (command, timeoutMs) => {
          ran.push(command);
          expect(timeoutMs).toBeLessThanOrEqual(10_000);
          return "ok";
        },
      });
      expect(ran.sort()).toEqual(["claude auth status", "codex login status"]);
      expect(r.status).toBe("ok");
      expect(r.message).toContain("codex — openai/oauth · model=(variant default) signed in (`codex login status` passed)");
      expect(r.message).toContain("claude-code — anthropic/oauth · model=(variant default) signed in (`claude auth status` passed)");
      expect(r.message).not.toContain("if not done");
    });

    it("⚠ only when a verify command fails, naming the sign-in to run", () => {
      registerOAuth();
      const r = checkProviderMapping({ verify: (command) => (command.startsWith("codex") ? "failed" : "ok") });
      expect(r.status).toBe("warn");
      expect(r.message).toContain("⚠ codex — openai/oauth · model=(variant default) not signed in (`codex login status` failed)");
      expect(r.message).toContain("✓ claude-code");
      expect(r.remediation).toBe("Try: codex login");
    });

    it("a plain note, not a warning, when the verify command can't run", () => {
      registerOAuth();
      const r = checkProviderMapping({ verify: () => "unavailable" });
      expect(r.status).toBe("ok");
      expect(r.message).toContain("· codex — openai/oauth · model=(variant default) uses OAuth; couldn't run `codex login status`");
      expect(r.message).toMatch(/run `claude auth login` if not done/);
    });
  });

  it.skipIf(process.platform === "win32")("runRouteVerify: pass, fail, and can't-run (missing program, timeout)", () => {
    expect(runRouteVerify("true", 5_000)).toBe("ok");
    expect(runRouteVerify("exit 1", 5_000)).toBe("failed");
    expect(runRouteVerify("foreman-no-such-program-xyz status", 5_000)).toBe("unavailable");
    expect(runRouteVerify("sleep 5", 100)).toBe("unavailable");
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
