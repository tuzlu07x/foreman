import { statSync } from "node:fs";
import { loadHubConfig, referencedSecrets, type HubConfig } from "../mcp-hub/config.js";

// =============================================================================
// Hub-only secrets
// =============================================================================
//
// A credential an integration uses (a GitHub token, a Linear API key) is
// attached upstream by the MCP hub. No agent needs to read it, and one
// that could would hold a key to everything the integration reaches, with
// no mediation. So `secrets/get` refuses these names whatever policy.yaml
// says (`reserved:integration`), and they are never projected into agent
// config files. Plain `foreman mcp add` servers are unchanged.

/** Secrets referenced by integration-managed servers (enabled or not). */
export function hubOnlySecretNames(config: Pick<HubConfig, "servers">): Set<string> {
  const out = new Set<string>();
  for (const server of Object.values(config.servers)) {
    if (!server.integration) continue;
    for (const name of referencedSecrets(server)) out.add(name);
  }
  return out;
}

/**
 * Follow mcp.yaml: the current hub-only names, re-read when the file
 * changes. A file that is missing or stops parsing keeps the last known
 * set, so deleting or breaking mcp.yaml can't hand a hub credential to an
 * agent; a name is released only when a valid mcp.yaml stops using it.
 */
export function followHubOnlySecrets(mcpConfigPath: string): () => ReadonlySet<string> {
  let signature: string | null = null;
  let names = new Set<string>();
  return () => {
    const next = fileSignature(mcpConfigPath);
    if (next === signature) return names;
    signature = next;
    if (next === "missing") return names;
    try {
      names = hubOnlySecretNames(loadHubConfig(mcpConfigPath));
    } catch {
      // keep the last known set
    }
    return names;
  };
}

function fileSignature(path: string): string {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return "missing";
  }
}
