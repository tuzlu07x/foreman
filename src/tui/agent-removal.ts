import { revokeAgentToken, type AgentTokenStore } from "../core/agent-token.js";
import { unwireAgent, type UnwireResult } from "../core/agent-wiring.js";
import { findAgent, loadActiveRegistry, type AgentEntry } from "../core/registry-catalog.js";
import type { RegistryService } from "../core/registry.js";

// =============================================================================
// Removing an agent from the TUI (Agents `x`, Team `x`)
// =============================================================================
//
// Unregisters it, revokes its identity token (a removed agent's token must
// not keep proving it, #618) and takes Foreman's own wiring (its MCP entry,
// the Claude Code hook) out of the agent's config. The binary and the rest
// of its config stay: `foreman agent remove --uninstall` is the only way
// Foreman uninstalls anything.

/** Remove `agentId`; throws when it isn't registered. What was unwired is
 *  best-effort and never blocks the removal. */
export function removeAgentAndWiring(
  registry: RegistryService,
  tokens: AgentTokenStore | undefined,
  agentId: string,
): UnwireResult {
  const agent = registry.get(agentId);
  const registryId = typeof agent?.metadata?.registryId === "string" ? agent.metadata.registryId : null;
  registry.remove(agentId);
  if (tokens) revokeAgentToken(tokens, agentId);
  let entry: AgentEntry | null = null;
  try {
    entry = registryId ? findAgent(loadActiveRegistry().doc, registryId) : null;
  } catch {
    entry = null;
  }
  return unwireAgent(agentId, entry);
}
