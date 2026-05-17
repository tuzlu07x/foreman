import type { AgentEntry } from "./registry-catalog.js";

// =============================================================================
// Post-install MCP-register CLI hint (#298)
// =============================================================================
//
// Some partner runtimes (Hermes) maintain their own MCP server registry
// CLI-side rather than reading the YAML/JSON config block we inject during
// `foreman agent add`. Round 2 QA caught this: Foreman wrote the block to
// ~/.hermes/config.yaml, but `hermes mcp list` reported "No MCP servers
// configured" because Hermes only reads its own registry.
//
// When agents.json declares `mcp_register_cli`, the install log surfaces
// the templated command after registration so the user knows the extra
// step. The template supports `{agent_id}` substitution so the command
// references the actual agent id we registered (matches `--source`).

export interface McpRegisterHint {
  command: string;
  verify: string | null;
  note: string | null;
}

/**
 * Build the post-install MCP register hint for an agent, or `null` if the
 * agent doesn't need one. Pure — call sites just emit each non-null line.
 */
export function buildMcpRegisterHint(
  agentId: string,
  entry: AgentEntry,
): McpRegisterHint | null {
  if (!entry.mcp_register_cli) return null;
  const command = substitute(
    entry.mcp_register_cli.command_template,
    agentId,
  );
  const verify = entry.mcp_register_cli.verify_template
    ? substitute(entry.mcp_register_cli.verify_template, agentId)
    : null;
  const note = entry.mcp_register_cli.note ?? null;
  return { command, verify, note };
}

function substitute(template: string, agentId: string): string {
  return template.replace(/\{agent_id\}/g, agentId);
}
