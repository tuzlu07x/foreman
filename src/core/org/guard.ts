import { existsSync } from "node:fs";
import type { ForemanDb } from "../../db/client.js";
import { budgetStatus, formatUsd } from "../usage/report.js";
import { checkDelegation, HUMAN_SOURCES, loadOrg, rolesForAgent, type DelegationVerdict } from "./org.js";

// Enforcement point for org.yaml reporting lines. Called when a directive
// (`foreman write <agent> …`) is queued — from an agent's MCP
// `submit_command` or from the `foreman write` CLI run in an agent's shell
// (spawned agents carry FOREMAN_SPAWNED_BY, so they are not mistaken for
// the human at the keyboard).
//
// This keeps a crew of agents organised — work flows along the chart and
// a runaway agent cannot fan tasks out across the company — but it is not
// an identity boundary: an agent id is still self-declared (see SECURITY.md).

/** The person at the keyboard (CLI or TUI), not an agent: nobody to nudge,
 *  and no agent chain to watch for runaway loops. */
export function isHumanSource(sourceAgent: string | null | undefined): boolean {
  return sourceAgent !== null && sourceAgent !== undefined && HUMAN_SOURCES.has(sourceAgent.trim().toLowerCase());
}

export function orgDelegationVerdict(
  orgConfigPath: string,
  fromAgent: string | undefined,
  toAgent: string,
): DelegationVerdict | null {
  if (!fromAgent || isHumanSource(fromAgent)) return null;
  if (!existsSync(orgConfigPath)) return null;
  try {
    const org = loadOrg(orgConfigPath);
    return org ? checkDelegation(org, fromAgent, toAgent) : null;
  } catch {
    // An org chart that fails to load must not silently open every path.
    return { allowed: false, reason: "org.yaml is invalid — run `foreman org validate`" };
  }
}

/** Why `toAgent`'s department can't take new work from agents right now
 *  (its budget is spent and set to `on_exceed: pause`), or null. */
export function orgBudgetBlock(db: ForemanDb, orgConfigPath: string, toAgent: string): string | null {
  if (!existsSync(orgConfigPath)) return null;
  let org;
  try {
    org = loadOrg(orgConfigPath);
  } catch {
    return null; // orgDelegationVerdict already reports an invalid org.yaml
  }
  if (!org) return null;
  for (const roleId of rolesForAgent(org, toAgent)) {
    const deptId = org.roles[roleId]?.department;
    const dept = deptId ? org.departments[deptId] : undefined;
    if (!deptId || !dept?.budget || dept.budget.on_exceed !== "pause") continue;
    const status = budgetStatus(db, deptId, dept.budget);
    const over = status.checks.find((c) => c.spentUsd >= c.limitUsd);
    if (over) {
      return (
        `${dept.name} is over its ${over.period === "day" ? "daily" : "monthly"} budget ` +
        `(${formatUsd(over.spentUsd)} of ${formatUsd(over.limitUsd)})`
      );
    }
  }
  return null;
}

/** Who is delegating when `foreman write` runs: the spawned agent when
 *  Foreman started this shell's agent, otherwise the human (`cli`). */
export function cliDelegationSource(env: NodeJS.ProcessEnv = process.env): string {
  const spawnedBy = env.FOREMAN_SPAWNED_BY?.trim();
  return spawnedBy && spawnedBy.length > 0 ? spawnedBy : "cli";
}
