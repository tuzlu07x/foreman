import { loadOrg } from "./org/org.js";
import {
  foremanCliArgv,
  instanceLaunch,
  isInstance,
  rolePrompt,
  supportsInstances,
  writeInstanceTokenFile,
  type InstanceLaunch,
} from "./agent-instance.js";
import { ensureAgentToken } from "./agent-token.js";
import type { AgentEntry } from "./registry-catalog.js";
import type { SecretStore } from "./secret-store.js";

// How Foreman starts a role that runs as an instance of Claude Code or
// Codex: its own identity token, its own Foreman MCP server and its org.yaml
// role. Shared by the task launcher (start.ts) and `foreman open <role>`.

/**
 * The launch additions for a second (third, …) instance of an agent: its own
 * Foreman MCP server and identity, and its org.yaml role (agent-instance.ts).
 * Null for the agent itself, or one Foreman can't point at its own server;
 * a failure is logged and the agent runs with its config's wiring.
 */
export function instanceLaunchFor(
  agentId: string,
  entry: AgentEntry,
  store: SecretStore,
  paths: { stateDir: string; orgConfigPath: string },
): InstanceLaunch | null {
  if (!isInstance(agentId, entry) || !supportsInstances(entry)) return null;
  try {
    const tokenFile = writeInstanceTokenFile(paths.stateDir, agentId, ensureAgentToken(store, agentId));
    let role: string | null = null;
    try {
      const org = loadOrg(paths.orgConfigPath);
      const found = org ? Object.entries(org.roles).find(([, r]) => r.agent === agentId) : undefined;
      if (org && found) {
        const [roleId, r] = found;
        role = rolePrompt({
          company: org.company,
          roleId,
          title: r.title,
          department: r.department ? (org.departments[r.department]?.name ?? r.department) : undefined,
          responsibility: r.responsibility,
          instructions: r.instructions,
          agentId,
        });
      }
    } catch {
      // an unreadable org.yaml: no role, the task still runs
    }
    return instanceLaunch(entry, { agentId, tokenFile, foremanArgv: foremanCliArgv(), role });
  } catch (err) {
    process.stderr.write(
      `foreman: couldn't give ${agentId} its own identity (${err instanceof Error ? err.message : String(err)}); it runs with ${entry.id}'s wiring\n`,
    );
    return null;
  }
}
