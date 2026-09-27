import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

// =============================================================================
// Foreman Org — a company of agents, as configuration (`<configDir>/org.yaml`)
// =============================================================================
//
// Real companies scale through structure: a CEO sets direction, department
// heads own areas, teams execute, and work flows along reporting lines.
// Foreman Org gives a multi-agent setup the same shape:
//
//   human (you) ── ceo ─┬─ cto ── engineer, reviewer
//                       ├─ cmo ── content-writer
//                       └─ cfo
//
// The chart is load-bearing, not decoration:
//   * delegation follows the chart — an agent can hand work to its direct
//     reports, report back to its manager, or collaborate inside its
//     department; cross-department work goes through department heads;
//   * each department (or role) can be limited to specific MCP servers, so
//     finance agents see Stripe but not GitHub (least privilege, and fewer
//     tool definitions in every agent's context window);
//   * responsibilities are pushed into the registry so the existing
//     responsibility-violation risk rule knows what each agent is for.
//
// The human stays at the top: approvals always come to you.

export const HUMAN = "human";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

const RoleSchema = z
  .object({
    title: z.string().min(1).max(80),
    /** Registered agent id that fills this role (e.g. claude-code, codex). */
    agent: z.string().min(1).max(64),
    department: z.string().regex(ID_RE).optional(),
    /** Role id of the manager, or `human`. */
    reports_to: z.string().min(1),
    responsibility: z.string().min(1).max(400).optional(),
    /** Optional model override pushed to the agent (e.g. a cheaper model for
     *  routine roles — the biggest single token-cost lever). */
    model: z.string().min(1).max(120).optional(),
    /** MCP hub servers this role may use. Overrides the department list. */
    mcp_servers: z.array(z.string().min(1)).optional(),
  })
  .strict();

const DepartmentSchema = z
  .object({
    name: z.string().min(1).max(80),
    head: z.string().regex(ID_RE),
    description: z.string().max(400).optional(),
    /** MCP hub servers members of this department may use. Omit = no limit. */
    mcp_servers: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const OrgDocSchema = z
  .object({
    version: z.literal(1),
    company: z.string().min(1).max(120),
    mission: z.string().max(500).optional(),
    human: z
      .object({ name: z.string().max(80).optional(), title: z.string().max(80).optional() })
      .strict()
      .default({}),
    delegation: z
      .object({
        /** via_heads: only department heads talk across departments.
         *  allow: anyone may delegate across departments (still audited).
         *  deny: departments are isolated; only the human bridges them. */
        cross_department: z.enum(["via_heads", "allow", "deny"]).default("via_heads"),
        /** Let managers assign to anyone below them, not just direct reports. */
        skip_levels: z.boolean().default(false),
      })
      .strict()
      .default({}),
    departments: z.record(z.string(), DepartmentSchema).default({}),
    roles: z.record(z.string(), RoleSchema),
  })
  .strict();

export type OrgDoc = z.infer<typeof OrgDocSchema>;
export type OrgRole = z.infer<typeof RoleSchema>;
export type OrgDepartment = z.infer<typeof DepartmentSchema>;

export interface OrgIssue {
  level: "error" | "warning";
  message: string;
}

export class OrgValidationError extends Error {
  constructor(public readonly issues: OrgIssue[]) {
    super(`org.yaml is invalid:\n${issues.map((i) => `  - ${i.message}`).join("\n")}`);
    this.name = "OrgValidationError";
  }
}

export function parseOrgText(text: string): OrgDoc {
  const raw: unknown = parseYaml(text);
  const parsed = OrgDocSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new OrgValidationError(
      parsed.error.issues.map((i) => ({
        level: "error",
        message: `${i.path.join(".") || "(root)"}: ${i.message}`,
      })),
    );
  }
  const errors = validateOrg(parsed.data).filter((i) => i.level === "error");
  if (errors.length > 0) throw new OrgValidationError(errors);
  return parsed.data;
}

export function loadOrg(path: string): OrgDoc | null {
  if (!existsSync(path)) return null;
  return parseOrgText(readFileSync(path, "utf-8"));
}

export function saveOrgText(path: string, text: string): void {
  parseOrgText(text); // never write an org the loader would reject
  writeFileSync(path, text, { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
}

export function serializeOrg(doc: OrgDoc): string {
  return stringifyYaml(doc, { lineWidth: 100 });
}

/** Structural checks the schema cannot express. */
export function validateOrg(doc: OrgDoc, knownAgents?: ReadonlySet<string>): OrgIssue[] {
  const issues: OrgIssue[] = [];
  const roleIds = Object.keys(doc.roles);
  for (const id of roleIds) {
    if (!ID_RE.test(id)) issues.push({ level: "error", message: `role id '${id}' must be lowercase kebab-case` });
    if (id === HUMAN) issues.push({ level: "error", message: `'${HUMAN}' is reserved for you` });
  }
  for (const [id, role] of Object.entries(doc.roles)) {
    if (role.reports_to !== HUMAN && !doc.roles[role.reports_to]) {
      issues.push({ level: "error", message: `role '${id}' reports to unknown role '${role.reports_to}'` });
    }
    if (role.reports_to === id) {
      issues.push({ level: "error", message: `role '${id}' reports to itself` });
    }
    if (role.department && !doc.departments[role.department]) {
      issues.push({ level: "error", message: `role '${id}' is in unknown department '${role.department}'` });
    }
    if (knownAgents && !knownAgents.has(role.agent)) {
      issues.push({
        level: "warning",
        message: `role '${id}' uses agent '${role.agent}', which is not registered yet (foreman agent add ${role.agent})`,
      });
    }
  }
  for (const [id, dept] of Object.entries(doc.departments)) {
    const head = doc.roles[dept.head];
    if (!head) {
      issues.push({ level: "error", message: `department '${id}' has unknown head '${dept.head}'` });
    } else if (head.department !== id) {
      issues.push({ level: "error", message: `department '${id}' head '${dept.head}' must belong to that department` });
    }
  }
  for (const id of roleIds) {
    if (chainOf(doc, id).cycle) {
      issues.push({ level: "error", message: `reporting cycle detected at role '${id}'` });
      break;
    }
  }
  if (!roleIds.some((id) => doc.roles[id]!.reports_to === HUMAN)) {
    issues.push({ level: "error", message: "at least one role must report to `human`" });
  }
  const agentsToRoles = new Map<string, string[]>();
  for (const [id, role] of Object.entries(doc.roles)) {
    agentsToRoles.set(role.agent, [...(agentsToRoles.get(role.agent) ?? []), id]);
  }
  for (const [agent, roles] of agentsToRoles) {
    if (roles.length > 1) {
      issues.push({
        level: "warning",
        message: `agent '${agent}' fills ${roles.length} roles (${roles.join(", ")}) — Foreman treats it as holding all of them`,
      });
    }
  }
  return issues;
}

/** Walk up the reporting chain: [role, manager, …]. */
export function chainOf(doc: OrgDoc, roleId: string): { chain: string[]; cycle: boolean } {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = roleId;
  while (current && current !== HUMAN) {
    if (seen.has(current)) return { chain, cycle: true };
    seen.add(current);
    chain.push(current);
    current = doc.roles[current]?.reports_to;
  }
  return { chain, cycle: false };
}

/** Agent ids compare case-insensitively: callers lowercase what they get
 *  from chat commands, while org.yaml keeps whatever the user typed. */
export function rolesForAgent(doc: OrgDoc, agentId: string): string[] {
  const id = agentId.trim().toLowerCase();
  return Object.entries(doc.roles)
    .filter(([, r]) => r.agent.trim().toLowerCase() === id)
    .map(([roleId]) => roleId);
}

export function directReports(doc: OrgDoc, roleId: string): string[] {
  return Object.entries(doc.roles)
    .filter(([, r]) => r.reports_to === roleId)
    .map(([id]) => id);
}

function isHead(doc: OrgDoc, roleId: string): boolean {
  const dept = doc.roles[roleId]?.department;
  return Boolean(dept && doc.departments[dept]?.head === roleId);
}

export interface DelegationVerdict {
  allowed: boolean;
  /** Human-readable reason — surfaced in the audit log and chat reply. */
  reason: string;
}

/** Source ids that are the human (or Foreman acting for them). */
const HUMAN_SOURCES = new Set(["cli", "user", HUMAN, "foreman", "telegram", "tui"]);

/**
 * May `fromAgent` hand work to `toAgent`? Returns `null` when the org has no
 * opinion (either side is not part of the chart), so callers keep their
 * pre-org behaviour for agents outside the company.
 */
export function checkDelegation(
  doc: OrgDoc,
  fromAgent: string,
  toAgent: string,
): DelegationVerdict | null {
  if (HUMAN_SOURCES.has(fromAgent)) return { allowed: true, reason: "assigned by the human" };
  const fromRoles = rolesForAgent(doc, fromAgent);
  const toRoles = rolesForAgent(doc, toAgent);
  if (fromRoles.length === 0 || toRoles.length === 0) return null;
  if (fromAgent === toAgent) return { allowed: true, reason: "same agent" };

  for (const from of fromRoles) {
    for (const to of toRoles) {
      const verdict = checkRolePair(doc, from, to);
      if (verdict.allowed) return verdict;
    }
  }
  return {
    allowed: false,
    reason:
      `${fromRoles.join("/")} → ${toRoles.join("/")} is outside the reporting chain in org.yaml ` +
      `(${describeCrossPolicy(doc)})`,
  };
}

function checkRolePair(doc: OrgDoc, from: string, to: string): DelegationVerdict {
  const fromRole = doc.roles[from]!;
  const toRole = doc.roles[to]!;
  if (toRole.reports_to === from) return { allowed: true, reason: `${from} manages ${to}` };
  if (fromRole.reports_to === to) return { allowed: true, reason: `${from} reports to ${to}` };
  if (doc.delegation.skip_levels && chainOf(doc, to).chain.includes(from)) {
    return { allowed: true, reason: `${to} is in ${from}'s organisation` };
  }
  const sameDept = Boolean(fromRole.department) && fromRole.department === toRole.department;
  if (sameDept) return { allowed: true, reason: `same department (${fromRole.department})` };
  switch (doc.delegation.cross_department) {
    case "allow":
      return { allowed: true, reason: "cross-department delegation allowed by org.yaml" };
    case "via_heads":
      if (isHead(doc, from) && isHead(doc, to)) {
        return { allowed: true, reason: "department heads coordinate directly" };
      }
      return { allowed: false, reason: "cross-department work must go through department heads" };
    case "deny":
      return { allowed: false, reason: "departments are isolated" };
  }
}

function describeCrossPolicy(doc: OrgDoc): string {
  switch (doc.delegation.cross_department) {
    case "via_heads":
      return "cross-department work goes through department heads";
    case "deny":
      return "departments are isolated";
    case "allow":
      return "only reporting lines and departments apply";
  }
}

/**
 * MCP hub servers `agentId` may use, or `null` for "no org restriction"
 * (agent outside the org, or no role/department declares a list).
 */
export function allowedMcpServers(doc: OrgDoc, agentId: string): Set<string> | null {
  const roles = rolesForAgent(doc, agentId);
  if (roles.length === 0) return null;
  const allowed = new Set<string>();
  for (const id of roles) {
    const role = doc.roles[id]!;
    const list =
      role.mcp_servers ?? (role.department ? doc.departments[role.department]?.mcp_servers : undefined);
    if (!list) return null; // any unrestricted role lifts the limit
    for (const s of list) allowed.add(s);
  }
  return allowed;
}

/** Resolve an assignment target (role id, department id or agent id) to a role. */
export function resolveAssignee(doc: OrgDoc, target: string): string | null {
  if (doc.roles[target]) return target;
  const dept = doc.departments[target];
  if (dept) return dept.head;
  const byAgent = rolesForAgent(doc, target);
  return byAgent[0] ?? null;
}

export interface OrgTreeNode {
  roleId: string;
  role: OrgRole;
  children: OrgTreeNode[];
}

export function buildTree(doc: OrgDoc): OrgTreeNode[] {
  const build = (parent: string, depth: number): OrgTreeNode[] =>
    depth > 32
      ? []
      : Object.entries(doc.roles)
          .filter(([, r]) => r.reports_to === parent)
          .map(([roleId, role]) => ({ roleId, role, children: build(roleId, depth + 1) }));
  return build(HUMAN, 0);
}
