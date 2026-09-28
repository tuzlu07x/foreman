import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMessage, type McpStdioServices } from "../../src/cli/mcp-stdio.js";
import {
  FOREMAN_OWN_TOOLS,
  isForemanServedTool,
  isForemanWiring,
  type ForemanSelf,
} from "../../src/core/foreman-mcp-trust.js";
import { CALL_TOOL, SEARCH_TOOL } from "../../src/core/mcp-hub/hub.js";
import { buildMcpSnippet } from "../../src/core/agent-mcp-snippet.js";
import { mintAgentToken } from "../../src/core/agent-token.js";
import type { AgentEntry } from "../../src/core/registry-catalog.js";
import type { JSONRPCMessage } from "../../src/mcp/types.js";

// #619 — the PreToolUse hook may skip `mcp__foreman__*` tools only when they
// are Foreman's own and no project config swapped in another `foreman`.

const FOREMAN = { command: "foreman", args: ["mcp-stdio", "--source", "claude-code"] };

/** A Foreman install in `root` (bin/foreman -> dist/cli/index.js, like npm
 *  and Homebrew link it) plus a node binary, and the hook's view of them. */
function fakeInstall(root: string): { self: ForemanSelf; entry: string; bin: string; node: string } {
  const entry = join(root, "install", "dist", "cli", "index.js");
  mkdirSync(join(root, "install", "dist", "cli"), { recursive: true });
  writeFileSync(entry, "#!/usr/bin/env node\n", { mode: 0o755 });
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(entry, join(bin, "foreman"));
  const nodeDir = join(root, "node-bin");
  mkdirSync(nodeDir);
  writeFileSync(join(nodeDir, "node"), "", { mode: 0o755 });
  return {
    self: {
      entries: new Set([realpathSync(entry)]),
      node: realpathSync(join(nodeDir, "node")),
      path: [nodeDir, bin].join(delimiter),
    },
    entry,
    bin,
    node: join(nodeDir, "node"),
  };
}

describe("isForemanServedTool (#619)", () => {
  let root: string;
  let home: string;
  let project: string;
  let hubConfigPath: string;
  let install: ReturnType<typeof fakeInstall>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "foreman-trust-"));
    home = join(root, "home");
    project = join(root, "work", "app", "src");
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    hubConfigPath = join(root, "mcp.yaml");
    writeFileSync(hubConfigPath, "version: 1\nservers:\n  github:\n    command: npx\n    args: [-y, some-server]\n");
    install = fakeInstall(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const check = (tool: string, env: NodeJS.ProcessEnv = {}) =>
    isForemanServedTool(tool, { cwd: project, hubConfigPath, home, env, self: install.self });

  it("skips Foreman's own tools and hub tools of configured servers", () => {
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { foreman: FOREMAN } }));
    expect(check("mcp__foreman__submit_approval")).toBe(true);
    expect(check("mcp__foreman__foreman_call_tool")).toBe(true);
    expect(check("mcp__foreman__github__create_issue")).toBe(true);
  });

  it("gates tools Foreman doesn't serve, even under the foreman name", () => {
    expect(check("mcp__foreman__run_shell")).toBe(false);
    expect(check("mcp__foreman__notion__search")).toBe(false); // not in mcp.yaml
    expect(check("mcp__other__submit_approval")).toBe(false);
  });

  it("gates when a project .mcp.json (here or in a parent) defines another foreman server", () => {
    writeFileSync(
      join(root, "work", ".mcp.json"),
      JSON.stringify({ mcpServers: { foreman: { command: "node", args: ["./evil.js"] } } }),
    );
    expect(check("mcp__foreman__submit_approval")).toBe(false);
  });

  it("accepts the wiring `foreman agent add` writes, with the agent token in env (#618)", () => {
    const entry = { id: "claude-code", mcp_compatible: true } as AgentEntry;
    const snippet = buildMcpSnippet("claude-code", entry, mintAgentToken()).json as {
      mcpServers: { foreman: { env?: Record<string, string> } };
    };
    const wired = snippet.mcpServers.foreman;
    expect(wired.env?.FOREMAN_AGENT_TOKEN).toMatch(/^fat_/);
    expect(isForemanWiring(wired, install.self)).toBe(true);
    writeFileSync(join(home, ".claude.json"), JSON.stringify(snippet));
    writeFileSync(join(root, "work", ".mcp.json"), JSON.stringify(snippet));
    expect(check("mcp__foreman__submit_approval")).toBe(true);
    expect(check("mcp__foreman__github__create_issue")).toBe(true);
  });

  it("accepts a project .mcp.json that wires Foreman itself", () => {
    writeFileSync(join(root, "work", ".mcp.json"), JSON.stringify({ mcpServers: { foreman: FOREMAN } }));
    expect(check("mcp__foreman__org_post")).toBe(true);
  });

  it("gates when a local-scope entry in ~/.claude.json overrides foreman for this project", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { foreman: FOREMAN },
        projects: { [join(root, "work", "app")]: { mcpServers: { foreman: { type: "http", url: "https://x.example/mcp" } } } },
      }),
    );
    expect(check("mcp__foreman__org_post")).toBe(false);
  });

  it("also reads CLAUDE_CONFIG_DIR", () => {
    const configDir = join(root, "claude-config");
    mkdirSync(configDir);
    writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ mcpServers: { foreman: { command: "sh", args: ["-c", "x"] } } }));
    expect(check("mcp__foreman__org_post", { CLAUDE_CONFIG_DIR: configDir })).toBe(false);
  });

  it("gates when a config can't be read (fail closed)", () => {
    writeFileSync(join(project, ".mcp.json"), "{ not json");
    expect(check("mcp__foreman__org_post")).toBe(false);
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: ["foreman"] }));
    expect(check("mcp__foreman__org_post")).toBe(false);
  });

  it("recognises Foreman's wiring and nothing else", () => {
    const wiring = (server: unknown) => isForemanWiring(server, install.self);
    expect(wiring(FOREMAN)).toBe(true);
    expect(wiring({ command: "foreman", args: ["hook", "claude-code"] })).toBe(false);
    expect(wiring({ command: "node", args: ["./dist/cli/index.js", "run"] })).toBe(false);
    expect(wiring({ command: "bash", args: ["-c", "foreman mcp-stdio"] })).toBe(false);
    expect(wiring({ type: "http", url: "http://127.0.0.1:1/mcp" })).toBe(false);
    expect(wiring("foreman")).toBe(false);
  });

  describe("only this install, with only the agent token in env (#618 review)", () => {
    const wiring = (server: unknown, self: ForemanSelf = install.self) => isForemanWiring(server, self);

    it("trusts the snippets Foreman writes and this install by its real path", () => {
      expect(wiring({ ...FOREMAN, env: { FOREMAN_AGENT_TOKEN: "fat_x" } })).toBe(true);
      expect(wiring({ ...FOREMAN, type: "stdio", env: { FOREMAN_AGENT_TOKEN_FILE: "/run/agent.token" } })).toBe(true);
      expect(wiring({ ...FOREMAN, env: {} })).toBe(true);
      expect(wiring({ command: join(install.bin, "foreman"), args: ["mcp-stdio"] })).toBe(true);
      expect(wiring({ command: install.entry, args: ["mcp-stdio", "--source", "codex"] })).toBe(true);
      expect(wiring({ command: "node", args: [install.entry, "mcp-stdio"] })).toBe(true);
      expect(wiring({ command: install.node, args: [join(install.bin, "foreman"), "mcp-stdio"] })).toBe(true);
    });

    it("gates any env key beyond the agent token", () => {
      for (const env of [
        { FOREMAN_AGENT_TOKEN: "fat_x", FOREMAN_HOME: join(root, "evil-home") },
        { NODE_OPTIONS: `--require ${join(root, "evil.js")}` },
        { PATH: join(root, "evil-bin") },
        { FOREMAN_AGENT_TOKEN: 1 },
      ]) {
        expect(wiring({ ...FOREMAN, env })).toBe(false);
        expect(wiring({ command: "node", args: [install.entry, "mcp-stdio"], env })).toBe(false);
      }
      expect(wiring({ ...FOREMAN, env: ["FOREMAN_AGENT_TOKEN=fat_x"] })).toBe(false);
    });

    it("gates keys Foreman never writes (cwd, url, …)", () => {
      expect(wiring({ ...FOREMAN, cwd: join(root, "evil") })).toBe(false);
      expect(wiring({ ...FOREMAN, url: "http://127.0.0.1:1/mcp" })).toBe(false);
      expect(wiring({ ...FOREMAN, type: "sse" })).toBe(false);
    });

    it("gates a look-alike foreman at another path, relative or absolute", () => {
      const other = join(root, "other");
      mkdirSync(other);
      writeFileSync(join(other, "foreman"), "#!/bin/sh\nexec sh\n", { mode: 0o755 });
      writeFileSync(join(other, "node"), "", { mode: 0o755 });
      mkdirSync(join(other, "dist", "cli"), { recursive: true });
      writeFileSync(join(other, "dist", "cli", "index.js"), "", { mode: 0o755 });
      expect(wiring({ command: join(other, "foreman"), args: ["mcp-stdio"] })).toBe(false);
      expect(wiring({ command: "/usr/local/bin/foreman", args: ["mcp-stdio"] })).toBe(false);
      expect(wiring({ command: "./foreman", args: ["mcp-stdio"] })).toBe(false);
      expect(wiring({ command: "bin/foreman", args: ["mcp-stdio"] })).toBe(false);
      expect(wiring({ command: "node", args: [join(other, "dist", "cli", "index.js"), "mcp-stdio"] })).toBe(false);
      expect(wiring({ command: "node", args: ["/opt/foreman-agent/dist/cli/index.js", "mcp-stdio"] })).toBe(false);
      expect(wiring({ command: join(other, "node"), args: [install.entry, "mcp-stdio"] })).toBe(false);
      // A bare `foreman` that PATH resolves to another binary first.
      const shadowed = { ...install.self, path: [other, install.bin].join(delimiter) };
      expect(wiring(FOREMAN, shadowed)).toBe(false);
      // ...or to nothing, or past a relative PATH entry (resolved against the project).
      expect(wiring(FOREMAN, { ...install.self, path: "" })).toBe(false);
      expect(wiring(FOREMAN, { ...install.self, path: [".", install.bin].join(delimiter) })).toBe(false);
    });

    it("gates a project .mcp.json foreman that only looks like the real one", () => {
      writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { foreman: FOREMAN } }));
      expect(check("mcp__foreman__submit_approval")).toBe(true);
      const lookalike = { ...FOREMAN, env: { FOREMAN_AGENT_TOKEN: "fat_x", FOREMAN_HOME: join(root, "evil-home") } };
      writeFileSync(join(root, "work", ".mcp.json"), JSON.stringify({ mcpServers: { foreman: lookalike } }));
      expect(check("mcp__foreman__submit_approval")).toBe(false);
      writeFileSync(
        join(root, "work", ".mcp.json"),
        JSON.stringify({ mcpServers: { foreman: { command: join(root, "work", "foreman"), args: ["mcp-stdio"] } } }),
      );
      expect(check("mcp__foreman__submit_approval")).toBe(false);
    });
  });

  it("lists exactly the tools mcp-stdio serves itself", async () => {
    const services = {
      mediator: { handleRequest: vi.fn(), handleSecretGet: vi.fn() },
      approval: { submitFromAgent: vi.fn() },
      commandRouter: { dispatch: vi.fn() },
      audit: { logEvent: vi.fn(), logRequest: vi.fn() },
      registry: { heartbeat: vi.fn() },
      llmConfigPath: "/tmp/test-llm.yaml",
      configDir: "/tmp/test-config",
    } as unknown as McpStdioServices;
    const out = (await handleMessage(services, "claude-code", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    } as JSONRPCMessage)) as unknown as { result: { tools: Array<{ name: string }> } };
    const served = new Set([...out.result.tools.map((t) => t.name), SEARCH_TOOL, CALL_TOOL]);
    expect([...served].sort()).toEqual([...FOREMAN_OWN_TOOLS].sort());
  });
});
