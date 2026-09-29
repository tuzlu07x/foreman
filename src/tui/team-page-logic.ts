import { buildTree, type OrgDoc, type OrgRole, type OrgTreeNode } from "../core/org/org.js";

// =============================================================================
// Team page (hotkey `t`): the org chart as rows, with who fills each role,
// on what, and what it may do.
// =============================================================================

export interface TeamRow {
  roleId: string;
  role: OrgRole;
  /** Tree lines before the title: `├─ `, `│  └─ `… */
  prefix: string;
  /** "Claude Code", "Codex"… from the registry, or null when unregistered. */
  runsOn: string | null;
  registered: boolean;
  department: string | null;
}

const RUNTIME_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  hermes: "Hermes",
  openclaw: "OpenClaw",
  zeroclaw: "ZeroClaw",
};

/** The registered agents Team needs: id and what program it runs. */
export interface TeamAgent {
  id: string;
  registryId?: string | undefined;
  displayName?: string | undefined;
}

function runtimeName(agent: TeamAgent): string {
  const type = agent.registryId ?? agent.id;
  return RUNTIME_NAMES[type] ?? agent.displayName ?? type;
}

/** Every role, in chart order (depth first under you). */
export function teamRows(org: OrgDoc, agents: readonly TeamAgent[]): TeamRow[] {
  const byId = new Map(agents.map((a) => [a.id.toLowerCase(), a]));
  const rows: TeamRow[] = [];
  const walk = (nodes: OrgTreeNode[], prefix: string): void => {
    nodes.forEach((node, i) => {
      const last = i === nodes.length - 1;
      const agent = byId.get(node.role.agent.toLowerCase());
      const dept = node.role.department;
      rows.push({
        roleId: node.roleId,
        role: node.role,
        prefix: `${prefix}${last ? "└─ " : "├─ "}`,
        runsOn: agent ? runtimeName(agent) : null,
        registered: agent !== undefined,
        department: dept ? (org.departments[dept]?.name ?? dept) : null,
      });
      walk(node.children, `${prefix}${last ? "   " : "│  "}`);
    });
  };
  walk(buildTree(org), "");
  return rows;
}

const CAN_WORDS: Record<string, string> = {
  read: "read files",
  write: "write files",
  shell: "run commands",
  network: "use the web",
};

/** What a role may do, in words. */
export function canWords(role: OrgRole): string {
  if (role.can === undefined) return "anything policy.yaml allows";
  if (role.can.length === 0) return "only talk to colleagues";
  return role.can.map((c) => CAN_WORDS[c] ?? c).join(", ");
}

/** Who a role reports to, in words. */
export function reportsToWords(org: OrgDoc, role: OrgRole): string {
  if (role.reports_to === "human") return "you";
  return org.roles[role.reports_to]?.title ?? role.reports_to;
}
