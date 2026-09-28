import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/cli/init.js";
import { ensureAgentToken } from "../../src/core/agent-token.js";
import { rewireAgent } from "../../src/core/agent-wiring.js";
import { checkAgentTokens, type CheckResult } from "../../src/core/doctor.js";
import { bus } from "../../src/core/event-bus.js";
import { findAgent, loadBundledRegistry } from "../../src/core/registry-catalog.js";
import { RegistryService } from "../../src/core/registry.js";
import { SecretStore } from "../../src/core/secret-store.js";
import { closeDb, getDb } from "../../src/db/client.js";
import { loadOrCreateSecretsMasterKey } from "../../src/identity/master-key.js";

// #618 — doctor counts an agent as proving its identity only when it has
// read the agent's wiring and found the current token there. An agent whose
// wiring it can't see (generic-mcp: no MCP config in the registry) gets its
// own warning row, never a share of the "proves its identity" claim.

describe("checkAgentTokens", () => {
  let tmp: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "foreman-doctor-tokens-"));
    for (const key of ["FOREMAN_HOME", "HOME"]) saved[key] = process.env[key];
    process.env.FOREMAN_HOME = join(tmp, "foreman");
    process.env.HOME = join(tmp, "home");
    mkdirSync(process.env.HOME, { recursive: true });
    runInit();
  });

  afterEach(() => {
    closeDb();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  const register = (id: string): void => {
    new RegistryService(getDb(), bus).register({
      id,
      displayName: id,
      transport: "stdio",
      metadata: { registryId: id },
    });
  };
  const store = (): SecretStore => new SecretStore(getDb(), loadOrCreateSecretsMasterKey());
  const rows = (): CheckResult[] => {
    const result = checkAgentTokens();
    return Array.isArray(result) ? result : [result];
  };

  it("counts only agents whose wiring it verified, and reports generic-mcp apart", () => {
    register("codex");
    rewireAgent(store(), "codex", findAgent(loadBundledRegistry(), "codex")); // ~/.codex/config.toml
    register("generic-mcp");
    ensureAgentToken(store(), "generic-mcp");

    const [main, ...rest] = rows();
    expect(main).toMatchObject({ name: "agent_tokens", status: "ok", message: "1 of 2 agents proves its identity with a token" });
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({ name: "agent_tokens:generic-mcp", status: "warn" });
    expect(rest[0]!.message).toBe(
      "generic-mcp: token issued, wiring not visible to doctor — make sure its MCP client passes " +
        "FOREMAN_AGENT_TOKEN (or FOREMAN_AGENT_TOKEN_FILE)",
    );
    expect(rest[0]!.remediation).toContain("foreman agent rewire generic-mcp --token-out <file>");
    expect(JSON.stringify(rows())).not.toMatch(/fat_[A-Za-z0-9_-]{20,}/);
  });

  it("claims nothing when no agent's wiring is visible", () => {
    register("generic-mcp");
    ensureAgentToken(store(), "generic-mcp");
    const all = rows();
    expect(all.map((r) => [r.name, r.status])).toEqual([["agent_tokens:generic-mcp", "warn"]]);
    expect(JSON.stringify(all)).not.toContain("proves");
  });

  it("still says every agent proves its identity when every wiring was verified", () => {
    register("codex");
    rewireAgent(store(), "codex", findAgent(loadBundledRegistry(), "codex"));
    expect(rows()).toEqual([{ name: "agent_tokens", status: "ok", message: "1 agent proves its identity with a token" }]);
  });
});
