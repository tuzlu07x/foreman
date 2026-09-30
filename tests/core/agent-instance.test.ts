import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueAgentToken, resolveAgentIdentity, takeAgentToken } from "../../src/core/agent-token.js";
import { SecretStore } from "../../src/core/secret-store.js";
import { createInMemoryDb } from "../../src/db/client.js";
import { generateMasterKey } from "../../src/identity/encryption.js";
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
    expect(launch.args.filter((a) => a === "-c")).toHaveLength(4);
    const overrides = launch.args.filter((a) => a !== "-c").map((a) => parseToml(a) as { mcp_servers: { foreman: Record<string, unknown> } });
    const server = Object.assign({}, ...overrides.map((o) => o.mcp_servers.foreman));
    expect(server).toEqual({
      command: "/opt/node/bin/node",
      args: ["/opt/foreman/dist/cli/index.js", "mcp-stdio", "--source", "backend"],
      env: { FOREMAN_AGENT_TOKEN: "", FOREMAN_AGENT_TOKEN_FILE: '/state/agent-tokens/back"end.token' },
      enabled: true,
    });
    // Codex has no system-prompt flag: the role leads the task.
    expect(launch.taskPrefix).toBe("You are the backend developer.\n\n");
    expect(launch.args.join(" ")).not.toContain("fat_");
  });

  // The 2.3.0 real test: backend (a Codex instance) reported as
  // `untrusted:backend` (token-mismatch). Codex 0.159 merges `-c` tables
  // key by key into ~/.codex/config.toml, where `foreman agent add codex`
  // wrote plain Codex's token, and FOREMAN_AGENT_TOKEN wins over the file.
  it("runs a Codex instance as itself even when Codex's own config carries plain Codex's token", () => {
    const { db, sqlite } = createInMemoryDb();
    try {
      const store = new SecretStore(db, generateMasterKey());
      const codexToken = issueAgentToken(store, "codex");
      const tokenFile = writeInstanceTokenFile(dir, "backend", issueAgentToken(store, "backend"));
      const base = parseToml(
        `[mcp_servers.foreman]\ncommand = "foreman"\nargs = ["mcp-stdio", "--source", "codex"]\nenabled = false\nenv = { FOREMAN_AGENT_TOKEN = "${codexToken}" }\n`,
      ) as Record<string, unknown>;
      const launch = instanceLaunch({ id: "codex" }, { agentId: "backend", tokenFile, foremanArgv: ["/usr/local/bin/foreman"], role: null })!;
      // What Codex does with each `-c`: merge tables, replace everything else.
      const merged = launch.args.filter((a) => a !== "-c").reduce((acc, a) => mergeTables(acc, parseToml(a)), base);
      const server = (merged.mcp_servers as Record<string, Record<string, unknown>>).foreman!;
      expect(server.enabled).toBe(true);
      const args = server.args as string[];
      const env = { ...(server.env as Record<string, string>) };
      const identity = resolveAgentIdentity({ claimed: args[args.indexOf("--source") + 1], token: takeAgentToken(env).token, store });
      expect(identity).toMatchObject({ source: "backend", trusted: true, reason: "token" });
    } finally {
      sqlite.close();
    }
  });

  it("gives a Claude Code instance an --mcp-config that wins over its own foreman entry, and its role", () => {
    const launch = instanceLaunch(
      { id: "claude-code" },
      { agentId: "reviewer", tokenFile: "/s/reviewer.token", foremanArgv: ["/usr/local/bin/foreman"], role: "You are the reviewer." },
    )!;
    const cfg = JSON.parse(launch.args[launch.args.indexOf("--mcp-config") + 1]!) as unknown;
    expect(cfg).toEqual({
      mcpServers: { foreman: { command: "/usr/local/bin/foreman", args: ["mcp-stdio", "--source", "reviewer"], env: { FOREMAN_AGENT_TOKEN: "", FOREMAN_AGENT_TOKEN_FILE: "/s/reviewer.token" } } },
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

  it("puts the role's instructions between who it is and how to work", () => {
    const text = rolePrompt({ company: "Acme", roleId: "reviewer", title: "Code Reviewer", agentId: "reviewer", instructions: "Review diffs. Don't edit files." });
    expect(text).toContain('at Acme, working as the agent "reviewer".\n\nReview diffs. Don\'t edit files.\n\nWork only on the task');
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

function mergeTables(into: Record<string, unknown>, from: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...into };
  for (const [key, value] of Object.entries(from)) {
    const prev = out[key];
    const isTable = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
    out[key] = isTable(prev) && isTable(value) ? mergeTables(prev, value) : value;
  }
  return out;
}
