import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isUntrustedSource } from "../agent-identity.js";
import { allowedMcpServers, departmentsForAgent, loadOrg } from "../org/org.js";
import { isReservedSecretName } from "../secret-store.js";
import {
  enabledServers,
  loadHubConfig,
  mcpOAuthSecretName,
  type HubConfig,
  type ServerAccess,
} from "./config.js";
import { McpHub, type AgentScope, type HubOAuthSession } from "./hub.js";
import { McpOAuthSession } from "./oauth-session.js";
import type { McpOAuthSecretStore } from "./oauth-store.js";
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
  secretStore: McpOAuthSecretStore,
  onError: (message: string) => void = () => undefined,
): McpHub | null {
  const config = readHubConfigOrNull(paths, onError);
  return config ? buildHub(config, paths, secretStore) : null;
}

/** mcp.yaml, or `null` when it is missing or invalid (reported). */
export function readHubConfigOrNull(
  paths: Pick<HubPaths, "mcpConfigPath">,
  onError: (message: string) => void = () => undefined,
): HubConfig | null {
  if (!existsSync(paths.mcpConfigPath)) return null;
  try {
    return loadHubConfig(paths.mcpConfigPath);
  } catch (err) {
    onError(
      `mcp.yaml is invalid — MCP hub disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** A hub for a loaded config, or `null` when no server is enabled. */
export function buildHub(
  config: HubConfig,
  paths: HubPaths,
  secretStore: McpOAuthSecretStore,
): McpHub | null {
  if (enabledServers(config).length === 0) return null;
  return new McpHub({
    config,
    resolveSecret: (name) =>
      !isReservedSecretName(name) && secretStore.exists(name)
        ? secretStore.get(name)
        : null,
    pins: new ToolPinStore(
      config.security.pin_tool_definitions ? paths.mcpPinsPath : null,
    ),
    oauth: hubOAuthSessions(paths, secretStore),
  });
}

/** The lock every writer of a server's OAuth session takes (hub refresh,
 *  `foreman mcp login / logout / remove`): a file next to the pins. */
export function mcpOAuthLockPath(
  paths: Pick<HubPaths, "mcpPinsPath">,
  server: string,
): string {
  return join(dirname(paths.mcpPinsPath), `${mcpOAuthSecretName(server)}.lock`);
}

/** OAuth sessions for `auth: oauth` servers, backed by the encrypted store. */
export function hubOAuthSessions(
  paths: Pick<HubPaths, "mcpPinsPath">,
  store: McpOAuthSecretStore,
): (server: string, url: string) => HubOAuthSession {
  return (server, url) =>
    new McpOAuthSession({
      server,
      serverUrl: url,
      store,
      lockPath: mcpOAuthLockPath(paths, server),
    });
}

/** Which hub servers `agentId` may use: org.yaml's role / department list
 *  (`allowedMcpServers`) intersected with each server's own `access` block
 *  in mcp.yaml. An org.yaml that fails to load fails CLOSED (no hub
 *  servers) — least privilege must not silently widen because of a typo.
 *  An unverified connection (`untrusted:<id>`, #618) gets none: hub servers
 *  hold your credentials.
 *
 *  Without `hub`, only org.yaml applies (null = no restriction). With it,
 *  the result always lists the servers explicitly, so a server with an
 *  `access` block is never visible to an agent outside it. */
export function scopeForAgent(
  orgConfigPath: string,
  agentId: string,
  onError: (message: string) => void = () => undefined,
  hub?: Pick<HubConfig, "servers"> | null,
): AgentScope {
  if (isUntrustedSource(agentId)) return { allowedServers: new Set() };
  let orgAllowed: ReadonlySet<string> | null = null;
  let departments: ReadonlySet<string> = new Set();
  if (existsSync(orgConfigPath)) {
    try {
      const org = loadOrg(orgConfigPath);
      if (org) {
        orgAllowed = allowedMcpServers(org, agentId);
        departments = departmentsForAgent(org, agentId);
      }
    } catch (err) {
      onError(
        `org.yaml is invalid — no MCP hub servers for '${agentId}' until it is fixed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { allowedServers: new Set() };
    }
  }
  if (!hub) return { allowedServers: orgAllowed };
  const id = agentId.trim().toLowerCase();
  const allowed = new Set<string>();
  for (const [name, server] of Object.entries(hub.servers)) {
    if (orgAllowed && !orgAllowed.has(name)) continue;
    if (!accessAllows(server.access, id, departments)) continue;
    allowed.add(name);
  }
  return { allowedServers: allowed };
}

/** A server's `access` block: absent = every verified agent; otherwise the
 *  listed agents and the members of the listed departments; `{}` = nobody. */
export function accessAllows(
  access: ServerAccess | undefined,
  agentId: string,
  departments: ReadonlySet<string>,
): boolean {
  if (!access) return true;
  const id = agentId.trim().toLowerCase();
  if ((access.agents ?? []).some((a) => a.toLowerCase() === id)) return true;
  return (access.departments ?? []).some((d) => departments.has(d));
}
