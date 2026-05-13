import { describe, expect, it } from "vitest";
import { buildMcpSnippet } from "../../src/core/agent-mcp-snippet.js";
import type { AgentEntry } from "../../src/core/registry-catalog.js";

function makeEntry(overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    id: "hermes",
    name: "Hermes",
    tagline: "Personal assistant",
    homepage: "https://example.com/",
    install: { npm: "hermes-agent", brew: null },
    config_paths: ["~/.hermes/config.yaml"],
    config_snippet: null,
    required_secrets: ["anthropic-key"],
    optional_secrets: [],
    mcp_compatible: true,
    supported_versions: ">=2.0.0",
    min_foreman_version: "0.1.2",
    ...overrides,
  };
}

describe("buildMcpSnippet", () => {
  it("emits a Claude-Code-style mcpServers block for MCP-compatible agents", () => {
    const snippet = buildMcpSnippet("hermes", makeEntry());
    const servers = (
      snippet.json as {
        mcpServers: { foreman: { command: string; args: string[] } };
      }
    ).mcpServers;
    expect(servers.foreman.command).toBe("foreman");
    expect(servers.foreman.args).toEqual(["mcp-stdio", "--source", "hermes"]);
    expect(snippet.yaml).toContain("foreman");
    expect(snippet.yaml).toContain("--source");
  });

  it("emits a generic mcp.servers block when mcp_compatible is false", () => {
    const snippet = buildMcpSnippet(
      "legacy",
      makeEntry({ mcp_compatible: false }),
    );
    const block = snippet.json as {
      mcp?: { servers?: Record<string, unknown> };
    };
    expect(block.mcp?.servers).toHaveProperty("foreman");
  });

  it("threads the foreman agent id into the --source arg verbatim", () => {
    const snippet = buildMcpSnippet("custom-name-123", makeEntry());
    const servers = (
      snippet.json as { mcpServers: { foreman: { args: string[] } } }
    ).mcpServers;
    expect(servers.foreman.args).toContain("custom-name-123");
  });
});
