import { existsSync, readFileSync, statSync } from "node:fs";
import { claimedAgentOf } from "../agent-identity.js";
import { loadOrg, type OrgDoc, type RoleCapability } from "./org.js";

// =============================================================================
// Role permissions: what a role's agent may do with its own tools
// =============================================================================
//
// org.yaml `can` on a role limits its agent to reading files, writing
// files, running shell commands and reaching the network, in any mix. The
// mediator checks it before policy.yaml: a call outside the role is denied
// (`org:role`), whatever the policy says. Only narrower, never wider:
//   - an agent with no role, or a role without `can`, is not limited here;
//   - an unverified source claiming a role's agent (`untrusted:reviewer`) is
//     held to that role too, and ids compare ignoring case, as blocks do;
//   - an agent filling several roles may do what any of them may (a role
//     without `can` lifts the limit);
//   - tools outside these four families (Foreman's own org_post,
//     submit_command…, MCP hub tools, which follow mcp_servers) are left to
//     policy and the other checks;
//   - a broken org.yaml that sets `can` fails closed (createRoleGuard).

/** The capability a mediated tool needs, or null when roles don't govern it. */
export function capabilityOf(tool: string | undefined): RoleCapability | null {
  switch (tool) {
    case "read_file":
    case "search_files":
    case "list_files":
    case "stat":
      return "read";
    case "file_write":
    case "write_file":
    case "edit_file":
    case "delete_file":
      return "write";
    case "shell_exec":
      return "shell";
    case "network_fetch":
    case "web_fetch":
    case "web_search":
      return "network";
    default:
      return null;
  }
}

const CAPABILITY_WORDS: Record<RoleCapability, string> = {
  read: "read files",
  write: "write files",
  shell: "run shell commands",
  network: "reach the network",
};

/** Why `agentId` may not use `tool` under `org`, or null when it may. */
export function roleRefusal(org: OrgDoc | null, agentId: string, tool: string | undefined): string | null {
  const need = capabilityOf(tool);
  if (!org || need === null) return null;
  const who = claimedAgentOf(agentId).trim().toLowerCase();
  const roles = Object.entries(org.roles).filter(([, r]) => r.agent.toLowerCase() === who);
  if (roles.length === 0 || roles.some(([, r]) => r.can === undefined)) return null;
  if (roles.some(([, r]) => r.can!.includes(need))) return null;
  const [roleId, role] = roles[0]!;
  const may = [...new Set(roles.flatMap(([, r]) => r.can!))].map((c) => CAPABILITY_WORDS[c]);
  return (
    `${role.title} (${roleId}) may not ${CAPABILITY_WORDS[need]}` +
    (may.length > 0 ? `: this role may only ${may.join(", ")}` : ": this role has no tool permissions") +
    ` (org.yaml \`can\`)`
  );
}

/** A role guard for the mediator, reading org.yaml again when it changes.
 *  A broken org.yaml that sets `can` anywhere fails closed: every call in
 *  these four families is refused until `foreman org validate` passes, as
 *  delegation is (a typo must not lift a role's limits). One that sets no
 *  `can` limited nothing, so it still limits nothing. */
export function createRoleGuard(orgConfigPath: string): (agentId: string, tool: string | undefined) => string | null {
  let cached: { mtimeMs: number; org: OrgDoc | null; broken: boolean } | null = null;
  const current = (): { org: OrgDoc | null; broken: boolean } => {
    if (!existsSync(orgConfigPath)) return { org: null, broken: false };
    let mtimeMs: number;
    try {
      mtimeMs = statSync(orgConfigPath).mtimeMs;
    } catch {
      return { org: null, broken: true };
    }
    if (cached?.mtimeMs === mtimeMs) return cached;
    try {
      cached = { mtimeMs, org: loadOrg(orgConfigPath), broken: false };
    } catch {
      let limits = true;
      try {
        limits = /^\s*can\s*:/m.test(readFileSync(orgConfigPath, "utf-8"));
      } catch {
        // unreadable: assume it limits
      }
      cached = { mtimeMs, org: null, broken: limits };
    }
    return cached;
  };
  return (agentId, tool) => {
    const { org, broken } = current();
    if (broken && capabilityOf(tool) !== null) {
      return "org.yaml doesn't parse, so role permissions can't be checked: fix it (`foreman org validate`)";
    }
    return roleRefusal(org, agentId, tool);
  };
}
