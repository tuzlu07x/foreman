import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { isUntrustedSource } from "../agent-identity.js";
import { agentAddCommand } from "../registry-catalog.js";

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
// The human stays at the top: approvals always come to you. With
// `approvals.escalate_via_manager`, a manager agent may add a recommendation
// to its reports' low- and medium-risk approvals, but you still decide.

export const HUMAN = "human";

/** Words that name channels or you (#630); no role or department may use
 *  them, or a role called `boss` could read your threads. */
export const RESERVED_ORG_IDS: ReadonlySet<string> = new Set([
  "all",
  "all-hands",
  "allhands",
  "everyone",
  "company",
  "leadership",
  "heads",
  "boss",
  HUMAN,
  "owner",
  "you",
  "me",
]);

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** What a role's agent may do with its own tools (RoleSchema `can`). */
export const ROLE_CAPABILITIES = ["read", "write", "shell", "network"] as const;
export type RoleCapability = (typeof ROLE_CAPABILITIES)[number];

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
    /** What the role does, in your own words: the agent is told this when
     *  Foreman hands it work (role-library.ts has ready-made ones). */
    instructions: z.string().min(1).max(4000).optional(),
    /** What its agent may do with its own tools: read files, write files,
     *  run shell commands, reach the network. Unset: no limit beyond
     *  policy.yaml. Talking to colleagues (org_post, …) is always allowed
     *  (role-guard.ts). */
    can: z.array(z.enum(ROLE_CAPABILITIES)).optional(),
  })
  .strict();

/** Where a channel is mirrored: platform → channel (`slack: "#marketing"`,
 *  `discord: "123456789012345678"`). Any platform with a mirror adapter. */
const ChannelMapSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  z.string().min(1).max(120),
);

const BudgetSchema = z
  .object({
    monthly_usd: z.number().positive().max(1_000_000).optional(),
    daily_usd: z.number().positive().max(1_000_000).optional(),
    /** warn: alert only. pause: agents can't hand work into the department
     *  until the period resets; you still can. */
    on_exceed: z.enum(["warn", "pause"]).default("warn"),
  })
  .strict();

const DepartmentSchema = z
  .object({
    name: z.string().min(1).max(80),
    head: z.string().regex(ID_RE),
    description: z.string().max(400).optional(),
    /** MCP hub servers members of this department may use. Omit = no limit. */
    mcp_servers: z.array(z.string().min(1)).optional(),
    /** Spend limit for the department's agents (#629). */
    budget: BudgetSchema.optional(),
    /** Chat channels the department's conversation is mirrored to (#630). */
    channels: ChannelMapSchema.optional(),
  })
  .strict();

export const OrgDocSchema = z
  .object({
    version: z.literal(1),
    company: z.string().min(1).max(120),
    mission: z.string().max(500).optional(),
    human: z
      .object({
        name: z.string().max(80).optional(),
        title: z.string().max(80).optional(),
      })
      .strict()
      .default({}),
    delegation: z
      .object({
        /** via_heads: only department heads talk across departments.
         *  allow: anyone may delegate across departments (still audited).
         *  deny: departments are isolated; only the human bridges them. */
        cross_department: z
          .enum(["via_heads", "allow", "deny"])
          .default("via_heads"),
        /** Let managers assign to anyone below them, not just direct reports. */
        skip_levels: z.boolean().default(false),
      })
      .strict()
      .default({}),
    /** Approval escalation along reporting lines (#623). */
    approvals: z
      .object({
        /** Low- and medium-risk approvals an agent asks for also go to its
         *  manager agent, who may recommend allow or deny. Advice only:
         *  you still decide every approval. */
        escalate_via_manager: z.boolean().default(false),
      })
      .strict()
      .optional(),
    departments: z.record(z.string(), DepartmentSchema).default({}),
    roles: z.record(z.string(), RoleSchema),
    /** Company-wide channel mirrors (#630): all-hands, leadership,
     *  reports to you, and role-to-role threads. */
    channels: z
      .object({
        all: ChannelMapSchema.optional(),
        leadership: ChannelMapSchema.optional(),
        boss: ChannelMapSchema.optional(),
        direct: ChannelMapSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type OrgDoc = z.infer<typeof OrgDocSchema>;
export type OrgRole = z.infer<typeof RoleSchema>;
export type OrgDepartment = z.infer<typeof DepartmentSchema>;
export type OrgBudget = z.infer<typeof BudgetSchema>;

export interface OrgIssue {
  level: "error" | "warning";
  message: string;
}

export class OrgValidationError extends Error {
  constructor(public readonly issues: OrgIssue[]) {
    super(
      `org.yaml is invalid:\n${issues.map((i) => `  - ${i.message}`).join("\n")}`,
    );
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
export function validateOrg(
  doc: OrgDoc,
  knownAgents?: ReadonlySet<string>,
): OrgIssue[] {
  const issues: OrgIssue[] = [];
  const roleIds = Object.keys(doc.roles);
  for (const id of roleIds) {
    if (!ID_RE.test(id))
      issues.push({
        level: "error",
        message: `role id '${id}' must be lowercase kebab-case`,
      });
    if (RESERVED_ORG_IDS.has(id))
      issues.push({
        level: "error",
        message: `'${id}' is reserved (it names you or a channel)`,
      });
  }
  for (const id of Object.keys(doc.departments)) {
    if (RESERVED_ORG_IDS.has(id)) {
      issues.push({
        level: "error",
        message: `department id '${id}' is reserved (it names you or a channel)`,
      });
    }
  }
  for (const [id, role] of Object.entries(doc.roles)) {
    if (role.reports_to !== HUMAN && !doc.roles[role.reports_to]) {
      issues.push({
        level: "error",
        message: `role '${id}' reports to unknown role '${role.reports_to}'`,
      });
    }
    if (role.reports_to === id) {
      issues.push({
        level: "error",
        message: `role '${id}' reports to itself`,
      });
    }
    if (role.department && !doc.departments[role.department]) {
      issues.push({
        level: "error",
        message: `role '${id}' is in unknown department '${role.department}'`,
      });
    }
    if (knownAgents && !knownAgents.has(role.agent)) {
      issues.push({
        level: "warning",
        message: `role '${id}' uses agent '${role.agent}', which is not registered yet (${agentAddCommand(role.agent)})`,
      });
    }
  }
  for (const [id, dept] of Object.entries(doc.departments)) {
    const head = doc.roles[dept.head];
    if (!head) {
      issues.push({
        level: "error",
        message: `department '${id}' has unknown head '${dept.head}'`,
      });
    } else if (head.department !== id) {
      issues.push({
        level: "error",
        message: `department '${id}' head '${dept.head}' must belong to that department`,
      });
    }
  }
  for (const id of roleIds) {
    if (chainOf(doc, id).cycle) {
      issues.push({
        level: "error",
        message: `reporting cycle detected at role '${id}'`,
      });
      break;
    }
  }
  if (!roleIds.some((id) => doc.roles[id]!.reports_to === HUMAN)) {
    issues.push({
      level: "error",
      message: "at least one role must report to `human`",
    });
  }
  const agentsToRoles = new Map<string, string[]>();
  for (const [id, role] of Object.entries(doc.roles)) {
    agentsToRoles.set(role.agent, [
      ...(agentsToRoles.get(role.agent) ?? []),
      id,
    ]);
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
export function chainOf(
  doc: OrgDoc,
  roleId: string,
): { chain: string[]; cycle: boolean } {
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
  // An unverified MCP connection holds no role, whatever org.yaml says.
  if (isUntrustedSource(agentId)) return [];
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

/** Does org.yaml send low- and medium-risk approvals to the requester's
 *  manager agent for a recommendation (#623)? */
export function escalatesViaManager(doc: OrgDoc | null): boolean {
  return doc?.approvals?.escalate_via_manager === true;
}

export interface ReviewLine {
  /** The requester's role. */
  requesterRole: string;
  /** Its manager's role, which is asked to review. */
  managerRole: string;
  /** The agent filling the manager role (lowercase). */
  managerAgent: string;
}

/** Who reviews an approval `requesterAgent` asked for: the manager of each
 *  of its roles, when that manager is an agent. Never you (you decide
 *  anyway), and never the requesting agent itself. */
export function reviewLinesFor(
  doc: OrgDoc,
  requesterAgent: string,
): ReviewLine[] {
  const requester = requesterAgent.trim().toLowerCase();
  if (HUMAN_SOURCES.has(requester)) return [];
  const lines: ReviewLine[] = [];
  for (const requesterRole of rolesForAgent(doc, requester)) {
    const managerRole = doc.roles[requesterRole]?.reports_to;
    if (!managerRole || managerRole === HUMAN) continue;
    const manager = doc.roles[managerRole];
    if (!manager) continue;
    const managerAgent = manager.agent.trim().toLowerCase();
    if (managerAgent === requester) continue;
    if (lines.some((l) => l.managerRole === managerRole)) continue;
    lines.push({ requesterRole, managerRole, managerAgent });
  }
  return lines;
}

export function isHead(doc: OrgDoc, roleId: string): boolean {
  const dept = doc.roles[roleId]?.department;
  return Boolean(dept && doc.departments[dept]?.head === roleId);
}

export interface DelegationVerdict {
  allowed: boolean;
  /** Human-readable reason — surfaced in the audit log and chat reply. */
  reason: string;
  /** For a hand-off the chart blocks: the route it allows instead. */
  next?: string;
}

/** Source ids that are the human (or Foreman acting for them): the CLI,
 *  the TUI, and `/foreman` typed in Slack or Discord by an allowed user.
 *  The one list every check uses; `foreman mcp-stdio --source` refuses all
 *  of them, so an agent can't pass itself off as the human. */
export const HUMAN_SOURCES: ReadonlySet<string> = new Set([
  "cli",
  "user",
  HUMAN,
  "boss",
  "owner",
  "foreman",
  "telegram",
  "tui",
  "slack",
  "discord",
]);

/** An agent whose identity isn't proven by its token can't hand work to
 *  anyone: outside the chart it would otherwise keep pre-org freedom. */
export const UNTRUSTED_DELEGATION: DelegationVerdict = {
  allowed: false,
  reason:
    "the sender's identity is unverified (no valid agent token) — run `foreman agent rewire <agent>`",
};

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
  if (HUMAN_SOURCES.has(fromAgent.trim().toLowerCase()))
    return { allowed: true, reason: "assigned by the human" };
  if (isUntrustedSource(fromAgent)) return UNTRUSTED_DELEGATION;
  const fromRoles = rolesForAgent(doc, fromAgent);
  const toRoles = rolesForAgent(doc, toAgent);
  if (fromRoles.length === 0 || toRoles.length === 0) return null;
  if (fromAgent === toAgent) return { allowed: true, reason: "same agent" };

  let blocked: { from: string; to: string; verdict: DelegationVerdict } | null = null;
  for (const from of fromRoles) {
    for (const to of toRoles) {
      const verdict = checkRolePair(doc, from, to);
      if (verdict.allowed) return verdict;
      blocked ??= { from, to, verdict };
    }
  }
  // Keep the pair's own reason (which part of the chart blocks it) and
  // say which route the chart allows instead.
  const { from, to, verdict } = blocked!;
  return {
    allowed: false,
    reason:
      `${fromRoles.join("/")} → ${toRoles.join("/")} is outside the reporting chain in org.yaml: ` +
      verdict.reason,
    next: nextHop(doc, from, to),
  };
}

/** Where role `from` can send work meant for role `to` when the chart
 *  blocks the direct hand-off: `to`'s department head when `from` may
 *  reach it, otherwise `from`'s manager, otherwise you (the human). */
export function nextHop(doc: OrgDoc, from: string, to: string): string {
  const who = (roleId: string): string => `${roleId} (${doc.roles[roleId]!.agent})`;
  const toDept = doc.roles[to]?.department;
  const toHead = toDept ? doc.departments[toDept]?.head : undefined;
  if (
    toDept &&
    toHead &&
    toHead !== to &&
    toHead !== from &&
    doc.roles[toHead] &&
    checkRolePair(doc, from, toHead).allowed
  ) {
    return `hand it to ${who(toHead)}, head of ${doc.departments[toDept]!.name}, who can assign it to ${to}`;
  }
  const manager = doc.roles[from]?.reports_to;
  if (manager && manager !== HUMAN && doc.roles[manager]) {
    return (
      `hand it to ${who(manager)}, ${from}'s manager` +
      (checkRolePair(doc, manager, to).allowed ? `, who can assign it to ${to}` : "")
    );
  }
  return `ask the human to assign it: foreman org assign ${to} "<task>"`;
}

export function checkRolePair(
  doc: OrgDoc,
  from: string,
  to: string,
): DelegationVerdict {
  const fromRole = doc.roles[from]!;
  const toRole = doc.roles[to]!;
  if (toRole.reports_to === from)
    return { allowed: true, reason: `${from} manages ${to}` };
  if (fromRole.reports_to === to)
    return { allowed: true, reason: `${from} reports to ${to}` };
  if (doc.delegation.skip_levels && chainOf(doc, to).chain.includes(from)) {
    return { allowed: true, reason: `${to} is in ${from}'s organisation` };
  }
  const sameDept =
    Boolean(fromRole.department) && fromRole.department === toRole.department;
  if (sameDept)
    return {
      allowed: true,
      reason: `same department (${fromRole.department})`,
    };
  switch (doc.delegation.cross_department) {
    case "allow":
      return {
        allowed: true,
        reason: "cross-department delegation allowed by org.yaml",
      };
    case "via_heads":
      if (isHead(doc, from) && isHead(doc, to)) {
        return {
          allowed: true,
          reason: "department heads coordinate directly",
        };
      }
      return {
        allowed: false,
        reason: "cross-department work must go through department heads",
      };
    case "deny":
      return { allowed: false, reason: "departments are isolated" };
  }
}

/**
 * MCP hub servers `agentId` may use, or `null` for "no org restriction"
 * (agent outside the org, or no role/department declares a list).
 */
export function allowedMcpServers(
  doc: OrgDoc,
  agentId: string,
): Set<string> | null {
  if (isUntrustedSource(agentId)) return new Set();
  const roles = rolesForAgent(doc, agentId);
  if (roles.length === 0) return null;
  const allowed = new Set<string>();
  for (const id of roles) {
    const role = doc.roles[id]!;
    const list =
      role.mcp_servers ??
      (role.department
        ? doc.departments[role.department]?.mcp_servers
        : undefined);
    if (!list) return null; // any unrestricted role lifts the limit
    for (const s of list) allowed.add(s);
  }
  return allowed;
}

/** Departments `agentId` belongs to through its roles (no department for
 *  an unverified connection). Used for mcp.yaml `access.departments`. */
export function departmentsForAgent(doc: OrgDoc, agentId: string): Set<string> {
  const out = new Set<string>();
  for (const id of rolesForAgent(doc, agentId)) {
    const department = doc.roles[id]!.department;
    if (department) out.add(department);
  }
  return out;
}

/** Resolve an assignment target (role id, department id or agent id) to a role. */
export function resolveAssignee(doc: OrgDoc, target: string): string | null {
  if (Object.hasOwn(doc.roles, target)) return target;
  const dept = Object.hasOwn(doc.departments, target)
    ? doc.departments[target]
    : undefined;
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
          .map(([roleId, role]) => ({
            roleId,
            role,
            children: build(roleId, depth + 1),
          }));
  return build(HUMAN, 0);
}

/** Plain-text org chart, one line per role (chat replies, the TUI). */
export function renderOrgLines(
  doc: OrgDoc,
  registered: ReadonlySet<string> = new Set(),
): string[] {
  const lines = [
    `${doc.company}${doc.mission ? ` — ${doc.mission}` : ""}`,
    `you${doc.human.title ? ` (${doc.human.title})` : ""}`,
  ];
  const walk = (nodes: OrgTreeNode[], prefix: string): void => {
    nodes.forEach((node, i) => {
      const last = i === nodes.length - 1;
      const { role } = node;
      const dot =
        registered.size === 0 || registered.has(role.agent.toLowerCase())
          ? "●"
          : "○";
      const dept = role.department
        ? ` [${doc.departments[role.department]?.name ?? role.department}]`
        : "";
      lines.push(
        `${prefix}${last ? "└─" : "├─"} ${node.roleId} · ${role.title} · ${dot} ${role.agent}${dept}`,
      );
      walk(node.children, `${prefix}${last ? "   " : "│  "}`);
    });
  };
  walk(buildTree(doc), "");
  return lines;
}
