import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  hubOnlySecretNames,
  followHubOnlySecrets,
} from "../../../src/core/integrations/hub-only-secrets.js";
import { accessAllows, scopeForAgent } from "../../../src/core/mcp-hub/boot.js";
import {
  parseHubConfigText,
  type HubConfig,
} from "../../../src/core/mcp-hub/config.js";
import type { McpHub } from "../../../src/core/mcp-hub/hub.js";
import { HubRuntime, SharedHub } from "../../../src/core/mcp-hub/runtime.js";

const ORG = [
  "version: 1",
  "company: Acme",
  "departments:",
  "  eng: { name: Engineering, head: cto, mcp_servers: [github, linear, jira] }",
  "  sales: { name: Sales, head: vp-sales }",
  "roles:",
  "  cto: { title: CTO, agent: claude-code, department: eng, reports_to: human }",
  "  vp-sales: { title: VP Sales, agent: hermes, department: sales, reports_to: human }",
  "",
].join("\n");

const HUB = [
  "servers:",
  "  github: { command: node, access: { departments: [eng] } }",
  "  linear: { command: node, access: { agents: [hermes] } }",
  "  jira: { command: node, access: {} }",
  "  open: { command: node }",
  "",
].join("\n");

describe("accessAllows", () => {
  it("absent = every verified agent, {} = nobody, else agents and departments", () => {
    expect(accessAllows(undefined, "x", new Set())).toBe(true);
    expect(accessAllows({}, "x", new Set(["eng"]))).toBe(false);
    expect(accessAllows({ agents: ["Codex"] }, "codex", new Set())).toBe(true);
    expect(accessAllows({ departments: ["eng"] }, "x", new Set(["eng"]))).toBe(
      true,
    );
    expect(
      accessAllows({ departments: ["eng"] }, "x", new Set(["sales"])),
    ).toBe(false);
  });
});

describe("scopeForAgent with mcp.yaml access", () => {
  let dir: string;
  const org = () => join(dir, "org.yaml");
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-scope-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const hub = parseHubConfigText(HUB);
  const allowed = (agent: string) =>
    [
      ...(scopeForAgent(org(), agent, () => undefined, hub).allowedServers ??
        []),
    ].sort();

  it("intersects org.yaml with each server access list", () => {
    writeFileSync(org(), ORG);
    // claude-code: eng department → github (dept access) ; linear is hermes-only; jira nobody; open not in eng list
    expect(allowed("claude-code")).toEqual(["github"]);
    // hermes: sales (no org limit) → linear (named) + open ; not github (eng only), not jira
    expect(allowed("hermes")).toEqual(["linear", "open"]);
    // an agent with no role: no org limit, no department
    expect(allowed("codex")).toEqual(["open"]);
  });

  it("applies access without an org.yaml", () => {
    expect(allowed("hermes")).toEqual(["linear", "open"]);
    expect(allowed("claude-code")).toEqual(["open"]);
  });

  it("gives an unverified connection nothing and fails closed on a broken org.yaml", () => {
    writeFileSync(org(), ORG);
    expect(allowed("untrusted:hermes")).toEqual([]);
    writeFileSync(org(), "roles: [broken");
    const errors: string[] = [];
    expect([
      ...scopeForAgent(org(), "hermes", (m) => errors.push(m), hub)
        .allowedServers!,
    ]).toEqual([]);
    expect(errors.join()).toMatch(/org.yaml is invalid/);
  });
});

// =============================================================================
// HubRuntime — rebuilds on file changes, fails closed, retires old hubs
// =============================================================================

describe("HubRuntime", () => {
  let dir: string;
  let clock: number;
  let built: Array<{ config: HubConfig; close: Mock<() => Promise<undefined>> }>;
  const mcp = () => join(dir, "mcp.yaml");
  const write = (text: string) => {
    // atomic like updateHubConfig, so the inode changes every time
    writeFileSync(`${mcp()}.tmp`, text);
    renameSync(`${mcp()}.tmp`, mcp());
  };
  const runtime = (
    extra: Partial<ConstructorParameters<typeof HubRuntime>[0]> = {},
  ) =>
    new HubRuntime({
      paths: {
        mcpConfigPath: mcp(),
        mcpPinsPath: join(dir, "pins.json"),
        orgConfigPath: join(dir, "org.yaml"),
      },
      secretStore: { exists: () => false, get: () => "" } as never,
      agentId: "codex",
      now: () => clock,
      build: (config) => {
        const close = vi.fn(async () => undefined);
        built.push({ config, close });
        return { close } as unknown as McpHub;
      },
      ...extra,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-runtime-"));
    clock = 1_000_000;
    built = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("rebuilds when mcp.yaml changes (throttled) and says the tools changed", () => {
    write("servers:\n  a: { command: node }\n");
    const changed = vi.fn();
    const rt = runtime({ onToolsChanged: changed });
    expect(built).toHaveLength(1);
    expect([...rt.scope.allowedServers!]).toEqual(["a"]);

    write(
      "servers:\n  a: { command: node, enabled: false }\n  b: { command: node }\n",
    );
    rt.sync(); // within the throttle: nothing yet
    expect(built).toHaveLength(1);
    clock += 1_500;
    rt.sync();
    expect(built).toHaveLength(2);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(built[0]!.close).toHaveBeenCalled();
    clock += 1_500;
    rt.sync(); // unchanged file: no rebuild
    expect(built).toHaveLength(2);
  });

  it("has no hub at all when mcp.yaml stops parsing (fail closed)", () => {
    write("servers:\n  a: { command: node }\n");
    const errors: string[] = [];
    const rt = runtime({ onError: (m) => errors.push(m) });
    expect(rt.hub).not.toBeNull();
    write("servers: [nope");
    rt.sync({ force: true });
    expect(rt.hub).toBeNull();
    expect(rt.scope.allowedServers?.size).toBe(0);
    expect(errors.join()).toMatch(/mcp.yaml is invalid/);
  });

  it("keeps a replaced hub open until its running call finishes", async () => {
    write("servers:\n  a: { command: node }\n");
    const rt = runtime();
    let release!: () => void;
    const running = rt.run(() => new Promise<void>((r) => (release = r)));
    write("servers:\n  b: { command: node }\n");
    rt.sync({ force: true });
    expect(built[0]!.close).not.toHaveBeenCalled();
    release();
    await running;
    expect(built[0]!.close).toHaveBeenCalled();
  });

  it("recomputes the scope when the agent identity changes", () => {
    write("servers:\n  a: { command: node, access: { agents: [codex] } }\n");
    const rt = runtime();
    expect([...rt.scope.allowedServers!]).toEqual(["a"]);
    rt.setAgent("untrusted:codex");
    expect([...rt.scope.allowedServers!]).toEqual([]);
  });
});

describe("SharedHub (the daemon's hub, #616)", () => {
  let dir: string;
  let built: Array<{ close: Mock<() => Promise<undefined>>; resetSession: Mock<() => void> }>;
  const paths = () => ({
    mcpConfigPath: join(dir, "mcp.yaml"),
    mcpPinsPath: join(dir, "pins.json"),
    orgConfigPath: join(dir, "org.yaml"),
  });
  const shared = () =>
    new SharedHub({
      paths: paths(),
      secretStore: { exists: () => false, get: () => "" } as never,
      build: () => {
        const hub = { close: vi.fn(async () => undefined), resetSession: vi.fn() };
        built.push(hub);
        return hub as unknown as McpHub;
      },
    });
  const view = (hub: SharedHub, agentId: string) =>
    new HubRuntime({
      paths: paths(),
      secretStore: { exists: () => false, get: () => "" } as never,
      agentId,
      shared: hub,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-shared-hub-"));
    built = [];
    writeFileSync(join(dir, "mcp.yaml"), HUB);
    writeFileSync(join(dir, "org.yaml"), ORG);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("builds one hub for every agent, with each agent's own scope", async () => {
    const hub = shared();
    const cto = view(hub, "claude-code");
    const sales = view(hub, "hermes");
    const stranger = view(hub, "untrusted:claude-code");
    expect(built).toHaveLength(1);
    expect(cto.hub).toBe(sales.hub);
    expect([...cto.scope.allowedServers!].sort()).toEqual(["github"]);
    expect([...sales.scope.allowedServers!].sort()).toEqual(["linear", "open"]);
    expect([...stranger.scope.allowedServers!]).toEqual([]);
    // A session ending doesn't take the shared hub down.
    await cto.close();
    expect(built[0]!.close).not.toHaveBeenCalled();
    await hub.close();
    expect(built[0]!.close).toHaveBeenCalled();
  });

  it("starts a new session from fresh pins, and picks up pins another process wrote", () => {
    const hub = shared();
    const agent = view(hub, "claude-code");
    hub.beginSession();
    expect(built[0]!.resetSession).toHaveBeenCalledTimes(1);
    agent.sync({ force: true });
    expect(built[0]!.resetSession).toHaveBeenCalledTimes(1); // pins unchanged
    writeFileSync(join(dir, "pins.json"), '{"version":1,"servers":{}}');
    agent.sync({ force: true });
    expect(built[0]!.resetSession).toHaveBeenCalledTimes(2);
  });
});

describe("hub-only secrets", () => {
  it("are the secrets integration servers reference, not plain servers", () => {
    const config = parseHubConfigText(
      [
        "servers:",
        '  plain: { command: node, env: { T: "${secret:plain-token}" } }',
        "  github:",
        "    url: https://api.githubcopilot.com/mcp/",
        '    headers: { Authorization: "Bearer ${secret:github-pat}" }',
        '    integration: { id: github, variant: official, access_level: read-only, created_at: "2026-09-28T00:00:00Z", updated_at: "2026-09-28T00:00:00Z" }',
        "",
      ].join("\n"),
    );
    expect([...hubOnlySecretNames(config)]).toEqual(["github-pat"]);
  });

  it("follows mcp.yaml and keeps the last set when the file breaks or disappears", () => {
    const dir = mkdtempSync(join(tmpdir(), "foreman-hubonly-"));
    try {
      const path = join(dir, "mcp.yaml");
      const names = followHubOnlySecrets(path);
      expect(names().size).toBe(0);
      writeFileSync(
        path,
        'servers:\n  gh:\n    url: https://x.example/mcp\n    headers: { Authorization: "Bearer ${secret:gh-pat}" }\n    integration: { id: github, variant: official, access_level: read-only, created_at: "2026-09-28T00:00:00Z", updated_at: "2026-09-28T00:00:00Z" }\n',
      );
      expect([...names()]).toEqual(["gh-pat"]);
      writeFileSync(path, "servers: [broken");
      expect([...names()]).toEqual(["gh-pat"]);
      rmSync(path);
      expect([...names()]).toEqual(["gh-pat"]);
      writeFileSync(path, "servers: {}\n");
      expect([...names()]).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
