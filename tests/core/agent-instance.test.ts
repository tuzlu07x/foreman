import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  catalogEntryFor,
  catalogIdFor,
  instanceLaunch,
  isInstance,
  removeInstanceTokenFile,
  rolePrompt,
  supportsInstances,
  writeInstanceTokenFile,
} from "../../src/core/agent-instance.js";

// Several roles on one agent runtime: `backend --type codex` runs as Codex,
// but talks to Foreman as `backend` (agent-instance.ts).

const DOC = {
  agents: [
    { id: "codex", name: "Codex" },
    { id: "claude-code", name: "Claude Code" },
    { id: "hermes", name: "Hermes" },
  ],
} as unknown as Parameters<typeof catalogEntryFor>[0];

describe("agent instances", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fm-inst-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("runs an agent as its registered type, else as its id", () => {
    expect(catalogIdFor("backend", { metadata: { registryId: "codex" } })).toBe("codex");
    expect(catalogIdFor("codex", { metadata: { registryId: "codex" } })).toBe("codex");
    expect(catalogIdFor("codex", null)).toBe("codex");
    // A catalog agent's own id wins over the type it was registered with.
    expect(catalogIdFor("codex", { metadata: { registryId: "generic-mcp" } }, (id) => id === "codex")).toBe("codex");
    expect(catalogEntryFor(DOC, "codex", { metadata: { registryId: "generic-mcp" } })?.id).toBe("codex");
    expect(catalogEntryFor(DOC, "backend", { metadata: { registryId: "codex" } })?.id).toBe("codex");
    // Registered before types were recorded: its id still finds it.
    expect(catalogEntryFor(DOC, "hermes", { metadata: { registryId: "generic-mcp" } })?.id).toBe("hermes");
    expect(catalogEntryFor(DOC, "nobody", null)).toBeUndefined();
    expect(isInstance("backend", { id: "codex" })).toBe(true);
    expect(isInstance("codex", { id: "codex" })).toBe(false);
    expect([supportsInstances({ id: "codex" }), supportsInstances({ id: "claude-code" }), supportsInstances({ id: "hermes" })]).toEqual([true, true, false]);
  });

  it("gives a Codex instance its own Foreman server with valid TOML overrides, token by file only", () => {
    const launch = instanceLaunch(
      { id: "codex" },
      { agentId: "backend", tokenFile: '/state/agent-tokens/back"end.token', foremanArgv: ["/opt/node/bin/node", "/opt/foreman/dist/cli/index.js"], role: "You are the backend developer." },
    )!;
    expect(launch.args.filter((a) => a === "-c")).toHaveLength(3);
    const overrides = launch.args.filter((a) => a !== "-c").map((a) => parseToml(a) as { mcp_servers: { foreman: Record<string, unknown> } });
    const server = Object.assign({}, ...overrides.map((o) => o.mcp_servers.foreman));
    expect(server).toEqual({
      command: "/opt/node/bin/node",
      args: ["/opt/foreman/dist/cli/index.js", "mcp-stdio", "--source", "backend"],
      env: { FOREMAN_AGENT_TOKEN_FILE: '/state/agent-tokens/back"end.token' },
    });
    // Codex has no system-prompt flag: the role leads the task.
    expect(launch.taskPrefix).toBe("You are the backend developer.\n\n");
    expect(launch.args.join(" ")).not.toContain("fat_");
  });

  it("gives a Claude Code instance an --mcp-config that wins over its own foreman entry, and its role", () => {
    const launch = instanceLaunch(
      { id: "claude-code" },
      { agentId: "reviewer", tokenFile: "/s/reviewer.token", foremanArgv: ["/usr/local/bin/foreman"], role: "You are the reviewer." },
    )!;
    const cfg = JSON.parse(launch.args[launch.args.indexOf("--mcp-config") + 1]!) as unknown;
    expect(cfg).toEqual({
      mcpServers: { foreman: { command: "/usr/local/bin/foreman", args: ["mcp-stdio", "--source", "reviewer"], env: { FOREMAN_AGENT_TOKEN_FILE: "/s/reviewer.token" } } },
    });
    expect(launch.args).not.toContain("--strict-mcp-config");
    expect(launch.args.slice(-2)).toEqual(["--append-system-prompt", "You are the reviewer."]);
    expect(launch.taskPrefix).toBe("");
    expect(instanceLaunch({ id: "hermes" }, { agentId: "ceo-2", tokenFile: "/x", foremanArgv: ["foreman"], role: null })).toBeNull();
  });

  it("keeps the token in an owner-only file, refreshed on each launch, and removes it", () => {
    const file = writeInstanceTokenFile(dir, "backend", "fat_first");
    expect(file).toBe(join(dir, "agent-tokens", "backend.token"));
    expect(statSync(join(dir, "agent-tokens")).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeInstanceTokenFile(dir, "backend", "fat_rotated");
    expect(readFileSync(file, "utf-8")).toBe("fat_rotated\n");
    removeInstanceTokenFile(dir, "backend");
    expect(existsSync(file)).toBe(false);
    removeInstanceTokenFile(dir, "backend");
  });

  it("refuses to write a token through a symlink", () => {
    const target = join(dir, "elsewhere");
    writeFileSync(target, "");
    writeInstanceTokenFile(dir, "x", "fat_1");
    rmSync(join(dir, "agent-tokens", "x.token"));
    symlinkSync(target, join(dir, "agent-tokens", "x.token"));
    expect(() => writeInstanceTokenFile(dir, "x", "fat_2")).toThrow(/symlink/);
    expect(readFileSync(target, "utf-8")).toBe("");
    expect(lstatSync(join(dir, "agent-tokens", "x.token")).isSymbolicLink()).toBe(true);
  });

  it("describes the role from org.yaml", () => {
    expect(
      rolePrompt({ company: "Acme", roleId: "backend-dev", title: "Backend Developer", department: "Engineering", responsibility: "the API", agentId: "backend" }),
    ).toBe(
      'You are Backend Developer (role "backend-dev" in Engineering) at Acme, working as the agent "backend". Your responsibility: the API. ' +
        "Work only on the task you were given; to talk to colleagues or report back, use Foreman's org_post and org_report tools.",
    );
  });
});
