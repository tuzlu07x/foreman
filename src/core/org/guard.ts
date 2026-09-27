import { existsSync } from "node:fs";
import { checkDelegation, loadOrg, type DelegationVerdict } from "./org.js";

// Enforcement point for org.yaml reporting lines. Called when a directive
// (`foreman write <agent> …`) is queued — from an agent's MCP
// `submit_command` or from the `foreman write` CLI run in an agent's shell
// (spawned agents carry FOREMAN_SPAWNED_BY, so they are not mistaken for
// the human at the keyboard).
//
// This keeps a crew of agents organised — work flows along the chart and
// a runaway agent cannot fan tasks out across the company — but it is not
// an identity boundary: an agent id is still self-declared (see SECURITY.md).

/** Source ids that mean "the human asked": the CLI, the TUI, and
 *  `/foreman` typed in Slack or Discord by an allowed user. Agents can't
 *  claim them (`foreman mcp-stdio --source` refuses these ids). */
const HUMAN_SOURCES = new Set(["cli", "user", "human", "tui", "slack", "discord"]);

/** The person at the keyboard (CLI or TUI), not an agent: nobody to nudge,
 *  and no agent chain to watch for runaway loops. */
export function isHumanSource(sourceAgent: string | null | undefined): boolean {
  return sourceAgent !== null && sourceAgent !== undefined && HUMAN_SOURCES.has(sourceAgent.toLowerCase());
}

export function orgDelegationVerdict(
  orgConfigPath: string,
  fromAgent: string | undefined,
  toAgent: string,
): DelegationVerdict | null {
  if (!fromAgent || HUMAN_SOURCES.has(fromAgent)) return null;
  if (!existsSync(orgConfigPath)) return null;
  try {
    const org = loadOrg(orgConfigPath);
    return org ? checkDelegation(org, fromAgent, toAgent) : null;
  } catch {
    // An org chart that fails to load must not silently open every path.
    return { allowed: false, reason: "org.yaml is invalid — run `foreman org validate`" };
  }
}

/** Who is delegating when `foreman write` runs: the spawned agent when
 *  Foreman started this shell's agent, otherwise the human (`cli`). */
export function cliDelegationSource(env: NodeJS.ProcessEnv = process.env): string {
  const spawnedBy = env.FOREMAN_SPAWNED_BY?.trim();
  return spawnedBy && spawnedBy.length > 0 ? spawnedBy : "cli";
}
