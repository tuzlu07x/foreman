import type { HubConfig, ServerConfig } from "../mcp-hub/config.js";
import { findIntegration, type IntegrationCatalog } from "./catalog.js";

// Name resolution for every surface (CLI, TUI, chat): the exact mcp.yaml
// server name first, then the integration id, then an alias. Two servers of
// the same integration (github, github-work) make an id or alias
// ambiguous — the caller asks "which one?" instead of guessing.

export type IntegrationResolution =
  | { kind: "found"; name: string; server: ServerConfig; via: "name" | "id" | "alias" }
  | { kind: "ambiguous"; candidates: string[] }
  /** A server that exists but is not managed as an integration. */
  | { kind: "not-integration"; name: string }
  | { kind: "not-found" };

export function resolveIntegration(
  config: HubConfig,
  catalog: IntegrationCatalog,
  query: string,
): IntegrationResolution {
  const key = query.trim().toLowerCase();
  if (key.length === 0) return { kind: "not-found" };
  const exact = Object.hasOwn(config.servers, key) ? config.servers[key] : undefined;
  if (exact?.integration) return { kind: "found", name: key, server: exact, via: "name" };
  const managed = Object.entries(config.servers).filter(([, s]) => s.integration);
  const byId = managed.filter(([, s]) => s.integration!.id === key);
  if (byId.length > 0) return pick(byId, "id");
  const entry = findIntegration(catalog, key);
  if (entry && entry.id !== key) {
    const byAlias = managed.filter(([, s]) => s.integration!.id === entry.id);
    if (byAlias.length > 0) return pick(byAlias, "alias");
  }
  // A plain `foreman mcp add` server of that name.
  return exact ? { kind: "not-integration", name: key } : { kind: "not-found" };
}

function pick(matches: Array<[string, ServerConfig]>, via: "id" | "alias"): IntegrationResolution {
  if (matches.length > 1) return { kind: "ambiguous", candidates: matches.map(([n]) => n).sort() };
  const [name, server] = matches[0]!;
  return { kind: "found", name, server, via };
}

/** Configured integration servers, sorted by name. */
export function integrationServers(config: HubConfig): Array<[string, ServerConfig]> {
  return Object.entries(config.servers)
    .filter(([, s]) => s.integration)
    .sort(([a], [b]) => a.localeCompare(b));
}
