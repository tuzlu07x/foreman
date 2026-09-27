import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMessage, type McpStdioServices } from "../../src/cli/mcp-stdio.js";
import {
  FOREMAN_OWN_TOOLS,
  isForemanServedTool,
  isForemanWiring,
} from "../../src/core/foreman-mcp-trust.js";
import { CALL_TOOL, SEARCH_TOOL } from "../../src/core/mcp-hub/hub.js";
import type { JSONRPCMessage } from "../../src/mcp/types.js";

// #619 — the PreToolUse hook may skip `mcp__foreman__*` tools only when they
// are Foreman's own and no project config swapped in another `foreman`.

const FOREMAN = { command: "foreman", args: ["mcp-stdio", "--source", "claude-code"] };

describe("isForemanServedTool (#619)", () => {
  let root: string;
  let home: string;
  let project: string;
  let hubConfigPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "foreman-trust-"));
    home = join(root, "home");
    project = join(root, "work", "app", "src");
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    hubConfigPath = join(root, "mcp.yaml");
    writeFileSync(hubConfigPath, "version: 1\nservers:\n  github:\n    command: npx\n    args: [-y, some-server]\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const check = (tool: string, env: NodeJS.ProcessEnv = {}) =>
    isForemanServedTool(tool, { cwd: project, hubConfigPath, home, env });

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
    expect(isForemanWiring(FOREMAN)).toBe(true);
    expect(isForemanWiring({ command: "/usr/local/bin/foreman", args: ["mcp-stdio"] })).toBe(true);
    expect(isForemanWiring({ command: "node", args: ["/opt/foreman-agent/dist/cli/index.js", "mcp-stdio"] })).toBe(true);
    expect(isForemanWiring({ command: "foreman", args: ["hook", "claude-code"] })).toBe(false);
    expect(isForemanWiring({ command: "node", args: ["./dist/cli/index.js", "run"] })).toBe(false);
    expect(isForemanWiring({ command: "bash", args: ["-c", "foreman mcp-stdio"] })).toBe(false);
    expect(isForemanWiring({ type: "http", url: "http://127.0.0.1:1/mcp" })).toBe(false);
    expect(isForemanWiring("foreman")).toBe(false);
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
