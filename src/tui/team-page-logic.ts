import { buildTree, HUMAN, type OrgDoc, type OrgRole, type OrgTreeNode } from "../core/org/org.js";
import { displayWidth, fitWidth, oneLine } from "./format.js";

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
  /** Leads its department (org.yaml `head`). */
  head: boolean;
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
        head: Boolean(dept && org.departments[dept]?.head === node.roleId),
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

/** `3 roles in 2 departments`, for the page header. */
export function teamCounts(org: OrgDoc): string {
  const roles = Object.keys(org.roles).length;
  const depts = Object.keys(org.departments).length;
  const r = `${roles} role${roles === 1 ? "" : "s"}`;
  return depts === 0 ? r : `${r} in ${depts} department${depts === 1 ? "" : "s"}`;
}

/** Who a role reports to, in words. */
export function reportsToWords(org: OrgDoc, role: OrgRole): string {
  if (role.reports_to === "human") return "you";
  return org.roles[role.reports_to]?.title ?? role.reports_to;
}

// =============================================================================
// The chart by department: a header per department (collapsible), its roles
// under it with the reporting lines inside the department, then the roles
// with no department. What each role runs on and which model it uses.
// =============================================================================

/** The group of roles with no department. */
export const NO_DEPARTMENT = "";

/** A registered agent as the Team page needs it. */
export interface TeamPageAgent extends TeamAgent {
  /** Foreman's model override for it (`modelVersion`), if any. */
  modelVersion?: string | null | undefined;
  /** active, blocked, disabled… */
  status?: string | undefined;
}

/** Which model a role uses, in words, and where that comes from. */
export interface TeamModel {
  text: string;
  source: "set-here" | "agent" | "default" | "none";
}

/** `Claude Code`, `Codex`, or the agent's own id. */
export function runtimeDisplayName(runtime: string): string {
  return RUNTIME_NAMES[runtime] ?? runtime;
}

/** `gpt-6-luna (set here)`, `gpt-6-luna (Codex's setting)` or `default model`. */
export function modelLabel(
  override: string | null | undefined,
  runtime: string | null,
  runtimeDefault: string | null,
): TeamModel {
  if (override) return { text: `${override} (set here)`, source: "set-here" };
  if (runtimeDefault) {
    return { text: `${runtimeDefault} (${runtime ? runtimeDisplayName(runtime) : "the agent"}'s setting)`, source: "agent" };
  }
  return { text: "default model", source: "default" };
}

export interface TeamRoleInfo {
  roleId: string;
  role: OrgRole;
  /** Tree lines inside its department: `├─ `, `│  └─ `… */
  prefix: string;
  /** The agent filling it (org.yaml `agent`). */
  agentId: string;
  /** The program that runs it (`claude-code`, `codex`, …), or null when its
   *  agent isn't registered. */
  runtime: string | null;
  /** "Claude Code", "Codex"… or null when unregistered. */
  runsOn: string | null;
  registered: boolean;
  /** Its agent's status when it isn't active (blocked, disabled). */
  status: string | null;
  /** Its agent is an instance named for a role, not the program itself
   *  (`claude-code`, `codex`). */
  instance: boolean;
  /** Leads its department. */
  head: boolean;
  model: TeamModel;
  /** Foreman's model override for its agent, if any. */
  modelOverride: string | null;
}

export interface TeamDepartmentRow {
  kind: "department";
  /** Department id, or NO_DEPARTMENT. */
  key: string;
  name: string;
  /** Its roles, collapsed or not. */
  roleIds: string[];
  /** Its head's title (null for "No department"). */
  head: string | null;
  collapsed: boolean;
  /** What its roles run on: one name, "mixed", or null with none registered. */
  runsOn: string | null;
}

export type TeamTreeRow = TeamDepartmentRow | { kind: "role"; key: string; department: string; info: TeamRoleInfo };

/** A tree row's selection key: `dept:<id>` or `role:<id>`. */
export function rowKey(row: TeamTreeRow): string {
  return row.kind === "department" ? `dept:${row.key}` : `role:${row.key}`;
}

/** Every role by department (org.yaml order), then "No department"; a
 *  collapsed department shows only its header. `defaults` is each
 *  program's own model (agentDefaultModel). */
export function teamTree(
  org: OrgDoc,
  agents: readonly TeamPageAgent[],
  collapsed: ReadonlySet<string> = new Set(),
  defaults: Readonly<Record<string, string | null>> = {},
): TeamTreeRow[] {
  const byId = new Map(agents.map((a) => [a.id.toLowerCase(), a]));
  // Chart order (depth first under you): a department lists its roles the
  // way the whole chart would.
  const order: string[] = [];
  const walk = (nodes: OrgTreeNode[]): void => {
    for (const n of nodes) {
      order.push(n.roleId);
      walk(n.children);
    }
  };
  walk(buildTree(org));
  const groupOf = (roleId: string): string => {
    const d = org.roles[roleId]?.department;
    return d && org.departments[d] ? d : NO_DEPARTMENT;
  };
  const info = (roleId: string, prefix: string): TeamRoleInfo => {
    const role = org.roles[roleId]!;
    const agent = byId.get(role.agent.toLowerCase());
    const runtime = agent ? (agent.registryId ?? agent.id) : null;
    const dept = role.department;
    const override = agent?.modelVersion ?? null;
    return {
      roleId,
      role,
      prefix,
      agentId: role.agent,
      runtime,
      runsOn: agent ? runtimeName(agent) : null,
      registered: agent !== undefined,
      status: agent?.status && agent.status !== "active" ? agent.status : null,
      instance: agent !== undefined && runtime !== agent.id,
      head: Boolean(dept && org.departments[dept]?.head === roleId),
      model: agent ? modelLabel(override, runtime, runtime ? (defaults[runtime] ?? null) : null) : { text: "—", source: "none" },
      modelOverride: override,
    };
  };
  const rows: TeamTreeRow[] = [];
  for (const group of [...Object.keys(org.departments), NO_DEPARTMENT]) {
    const members = order.filter((id) => groupOf(id) === group);
    if (group === NO_DEPARTMENT && members.length === 0) continue;
    const inGroup = new Set(members);
    // A role's parent here is its nearest manager in the same group.
    const localParent = (roleId: string): string | null => {
      const seen = new Set<string>();
      let up = org.roles[roleId]?.reports_to;
      while (up && up !== HUMAN && !seen.has(up)) {
        if (inGroup.has(up)) return up;
        seen.add(up);
        up = org.roles[up]?.reports_to;
      }
      return null;
    };
    const children = new Map<string | null, string[]>();
    for (const id of members) {
      const p = localParent(id);
      children.set(p, [...(children.get(p) ?? []), id]);
    }
    const infos: TeamRoleInfo[] = [];
    const place = (parent: string | null, prefix: string): void => {
      const kids = children.get(parent) ?? [];
      kids.forEach((id, i) => {
        const last = i === kids.length - 1;
        infos.push(info(id, `${prefix}${last ? "└─ " : "├─ "}`));
        place(id, `${prefix}${last ? "   " : "│  "}`);
      });
    };
    place(null, "");
    const dept = org.departments[group];
    const runtimes = new Set(infos.flatMap((r) => (r.runsOn ? [r.runsOn] : [])));
    rows.push({
      kind: "department",
      key: group,
      name: dept ? dept.name : "No department",
      roleIds: infos.map((r) => r.roleId),
      head: dept ? (org.roles[dept.head]?.title ?? dept.head) : null,
      collapsed: collapsed.has(group),
      runsOn: runtimes.size === 0 ? null : runtimes.size === 1 ? [...runtimes][0]! : "mixed",
    });
    if (collapsed.has(group)) continue;
    for (const r of infos) rows.push({ kind: "role", key: r.roleId, department: group, info: r });
  }
  return rows;
}

export interface TeamColumns {
  title: number;
  id: number;
  runtime: number;
  model: number;
}

/** The widest title (with its tree lines), role id and runtime among
 *  `infos`, so the columns fit what's in them. */
export function columnNeeds(infos: readonly TeamRoleInfo[]): Omit<TeamColumns, "model"> {
  let title = 0;
  let id = 0;
  let runtime = 0;
  for (const i of infos) {
    title = Math.max(title, displayWidth(oneLine(`  ${i.prefix}${titleText(i)}`)));
    id = Math.max(id, displayWidth(oneLine(i.roleId)));
    runtime = Math.max(runtime, displayWidth(runtimeText(i)));
  }
  return { title, id, runtime };
}

/** Column widths of a role row in `width` columns: title (with its tree
 *  lines), role id, runtime, then the model. Each but the last includes a
 *  one-column gap; together they are exactly `width`. Each column is as
 *  wide as `need` says (within limits); when they don't all fit, the id
 *  gives way first, then the title, then the runtime. */
export function teamColumns(
  width: number,
  need: Omit<TeamColumns, "model"> = { title: 29, id: 19, runtime: 12 },
): TeamColumns {
  const w = Math.max(24, Math.floor(width));
  let title = Math.min(40, Math.max(12, need.title + 1));
  let id = Math.min(24, Math.max(6, need.id + 1));
  let runtime = Math.min(18, Math.max(8, need.runtime + 1));
  const minModel = Math.min(20, Math.max(6, Math.floor(w * 0.25)));
  let over = title + id + runtime + minModel - w;
  const give = (have: number, floor: number): number => {
    const cut = Math.max(0, Math.min(over, have - floor));
    over -= cut;
    return have - cut;
  };
  id = give(id, 8);
  title = give(title, 14);
  runtime = give(runtime, 8);
  id = give(id, 4);
  title = give(title, 8);
  return { title, id, runtime, model: Math.max(0, w - title - id - runtime) };
}

/** `text` on one line in exactly `width` columns: cut with `…` so a
 *  one-column gap is left, then padded. */
export function cell(text: string, width: number): string {
  const cut = fitWidth(oneLine(text), Math.max(0, width - 1));
  return cut + " ".repeat(Math.max(0, width - displayWidth(cut)));
}

/** A role row's cells, each fitted to its column of `width` (the row
 *  without its two-column cursor). */
export function roleCells(
  info: TeamRoleInfo,
  width: number,
  cols: TeamColumns = teamColumns(width),
): { prefix: string; title: string; id: string; runtime: string; model: string } {
  const prefix = fitWidth(`  ${info.prefix}`, Math.max(0, cols.title - 6));
  return {
    prefix,
    title: cell(titleText(info), cols.title - displayWidth(prefix)),
    id: cell(info.roleId, cols.id),
    runtime: cell(runtimeText(info), cols.runtime),
    model: fitWidth(oneLine(info.model.text), cols.model),
  };
}

function titleText(info: TeamRoleInfo): string {
  return `${info.role.title}${info.head ? " (lead)" : ""}`;
}

function runtimeText(info: TeamRoleInfo): string {
  return info.registered ? `${info.runsOn ?? ""}${info.status ? ` (${info.status})` : ""}` : "not registered";
}

/** A department header in words: `IT · 3 roles · led by Backend Developer · Codex`. */
export function departmentLine(row: TeamDepartmentRow): string {
  const n = row.roleIds.length;
  return [row.name, `${n} role${n === 1 ? "" : "s"}`, row.head ? `led by ${row.head}` : null, row.runsOn]
    .filter(Boolean)
    .join(" · ");
}
