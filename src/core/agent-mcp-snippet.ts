import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { AGENT_TOKEN_ENV } from "./agent-token.js";
import type { AgentEntry } from "./registry-catalog.js";
import { resolveBundledRegistryPath } from "./registry-catalog.js";

export interface McpSnippet {
  // Generic shape: agents either copy this YAML block, or our injector merges
  // it into whatever format their config file uses.
  yaml: string;
  // Equivalent JSON object representation, merged into the agent's MCP
  // config (e.g. `mcpServers` in Claude Code's ~/.claude.json).
  json: Record<string, unknown>;
}

/** Stands in for the token wherever the snippet is shown rather than
 *  written (`foreman agent show`, manual-paste hints). */
export const AGENT_TOKEN_PLACEHOLDER = "<agent token: written by foreman agent rewire>";

/** The `mcp_bundles` entry that grants ZeroClaw agents the foreman server. */
export const ZEROCLAW_BUNDLE = "foreman";

// The JSON skeleton every Foreman-bridged agent needs in its config. The agent
// id from the *foreman* side is the one we record in `--source`; the token
// that proves it (#618) travels in the server's environment, never in argv.
// Without `token` the snippet carries a placeholder, so a caller that forgets
// it wires an untrusted agent rather than a privileged one.
export function buildMcpSnippet(
  agentId: string,
  entry: AgentEntry,
  token?: string,
): McpSnippet {
  const block = {
    command: "foreman",
    args: ["mcp-stdio", "--source", agentId],
    env: { [AGENT_TOKEN_ENV]: token ?? AGENT_TOKEN_PLACEHOLDER },
  };
  // Where the agent actually reads MCP servers, when the registry says so.
  if (entry.mcp_config?.layout === "zeroclaw") {
    // ZeroClaw: a named entry in the `[[mcp.servers]]` array, and a bundle
    // an agent must list in its `mcp_bundles` before it connects.
    const json = {
      mcp: { servers: [{ name: "foreman", ...block }] },
      mcp_bundles: { [ZEROCLAW_BUNDLE]: { servers: ["foreman"] } },
    };
    return { yaml: stringifyYaml(json), json };
  }
  if (entry.mcp_config) {
    const json = nestUnder(entry.mcp_config.key ?? "mcpServers", { foreman: block });
    return { yaml: stringifyYaml(json), json };
  }

  const topKey = entry.mcp_servers_key ?? "mcpServers";

  // #385 — explicit mcp_format takes precedence over the (mcp_compatible
  // ? flat : nested) heuristic. OpenClaw is mcp_compatible:true but
  // expects the nested {mcp:{servers}} shape per docs.openclaw.ai —
  // without this, Foreman writes a top-level `mcpServers` block its
  // schema validator rejects. #395 — the nested form must NOT include
  // `mcp.enabled`; OpenClaw's strict schema rejects it.
  const format =
    entry.mcp_format ?? (entry.mcp_compatible ? "flat" : "nested");

  const json: Record<string, unknown> =
    format === "flat"
      ? { [topKey]: { foreman: block } }
      : {
          mcp: {
            servers: { foreman: block },
          },
        };

  return { yaml: stringifyYaml(json), json };
}

/** `a.b` + value → `{ a: { b: value } }`. */
function nestUnder(dottedKey: string, value: unknown): Record<string, unknown> {
  return dottedKey
    .split(".")
    .reduceRight<Record<string, unknown>>((inner, key) => ({ [key]: inner }), value as Record<string, unknown>);
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
