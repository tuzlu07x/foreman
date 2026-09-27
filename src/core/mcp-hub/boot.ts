import { existsSync } from "node:fs";
import { allowedMcpServers, loadOrg } from "../org/org.js";
import type { SecretStore } from "../secret-store.js";
import { enabledServers, loadHubConfig } from "./config.js";
import { McpHub, type AgentScope } from "./hub.js";
import { ToolPinStore } from "./pins.js";

// Wiring helpers shared by `foreman mcp-stdio` and the `foreman mcp` CLI.

export interface HubPaths {
  mcpConfigPath: string;
  mcpPinsPath: string;
}

/** Build the hub from mcp.yaml, or `null` when no server is enabled. A
 *  broken mcp.yaml disables the hub (reported via `onError`) rather than
 *  taking Foreman's own tools down with it. */
export function loadHub(
  paths: HubPaths,
  secretStore: Pick<SecretStore, "exists" | "get">,
  onError: (message: string) => void = () => undefined,
): McpHub | null {
  if (!existsSync(paths.mcpConfigPath)) return null;
  let config;
  try {
    config = loadHubConfig(paths.mcpConfigPath);
  } catch (err) {
    onError(`mcp.yaml is invalid — MCP hub disabled: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (enabledServers(config).length === 0) return null;
  return new McpHub({
    config,
    resolveSecret: (name) => (secretStore.exists(name) ? secretStore.get(name) : null),
    pins: new ToolPinStore(config.security.pin_tool_definitions ? paths.mcpPinsPath : null),
  });
}

/** Which hub servers `agentId` may use according to org.yaml. An org.yaml
 *  that fails to load fails CLOSED (no hub servers) — least privilege must
 *  not silently widen because of a typo. */
export function scopeForAgent(
  orgConfigPath: string,
  agentId: string,
  onError: (message: string) => void = () => undefined,
): AgentScope {
  if (!existsSync(orgConfigPath)) return { allowedServers: null };
  try {
    const org = loadOrg(orgConfigPath);
    return { allowedServers: org ? allowedMcpServers(org, agentId) : null };
  } catch (err) {
    onError(
      `org.yaml is invalid — no MCP hub servers for '${agentId}' until it is fixed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { allowedServers: new Set() };
  }
}
