import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { AgentEntry } from "./registry-catalog.js";
import { resolveBundledRegistryPath } from "./registry-catalog.js";

export interface McpSnippet {
  // Generic shape: agents either copy this YAML block, or our injector merges
  // it into whatever format their config file uses.
  yaml: string;
  // Equivalent JSON object representation. Claude Code style config files
  // (~/.claude/settings.json) accept this directly under `mcpServers`.
  json: Record<string, unknown>;
}

// The JSON skeleton every Foreman-bridged agent needs in its config. The agent
// id from the *foreman* side is the one we record in `--source`.
export function buildMcpSnippet(
  agentId: string,
  entry: AgentEntry,
): McpSnippet {
  const block = {
    command: "foreman",
    args: ["mcp-stdio", "--source", agentId],
  };

  const json: Record<string, unknown> = entry.mcp_compatible
    ? { mcpServers: { foreman: block } }
    : {
        mcp: {
          enabled: true,
          servers: { foreman: block },
        },
      };

  return { yaml: stringifyYaml(json), json };
}

// Reads the snippet file shipped with the registry entry (if any) so we can
// preview the exact YAML block in the wizard before writing.
export function readBundledSnippet(entry: AgentEntry): string | null {
  if (!entry.config_snippet) return null;
  const registryPath = resolveBundledRegistryPath();
  if (!registryPath) return null;
  const registryRoot = registryPath.replace(/agents\.json$/, "");
  const snippetPath = resolve(registryRoot, "..", entry.config_snippet);
  if (!existsSync(snippetPath)) return null;
  return readFileSync(snippetPath, "utf-8");
}
