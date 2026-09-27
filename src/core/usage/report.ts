import { sql } from "drizzle-orm";
import type { ForemanDb } from "../../db/client.js";
import { rolesForAgent, type OrgBudget, type OrgDoc } from "../org/org.js";

// =============================================================================
// Org reports (#629) — what each department did, and what it cost
// =============================================================================
//
// Pure queries over the local database, no LLM: spend from `agent_usage`
// (plus Foreman's own `llm_usage`), tasks from `control_commands`, tool calls
// from `requests`, and task results from the inbox. The same report backs
// `foreman report`, `/foreman report` in every chat surface and the TUI.

export interface Period {
  label: string;
  since: number;
  until: number;
}

const DAY_MS = 86_400_000;

/** today | yesterday | week | month | 24h / 7d / 30d. Local time. */
export function parsePeriod(word: string | undefined, now: number = Date.now()): Period | null {
  const w = (word ?? "today").trim().toLowerCase();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  switch (w) {
    case "today":
    case "bugün":
    case "bugun":
      return { label: "today", since: midnight.getTime(), until: now };
    case "yesterday":
    case "dün":
    case "dun": {
      // Calendar arithmetic, not -24h: a daylight-saving day is 23 or 25 h.
      const start = new Date(midnight);
      start.setDate(start.getDate() - 1);
      return { label: "yesterday", since: start.getTime(), until: midnight.getTime() };
    }
    case "week":
    case "hafta":
      return { label: "last 7 days", since: now - 7 * DAY_MS, until: now };
    case "month":
    case "ay": {
      const start = new Date(midnight);
      start.setDate(1);
      return { label: "this month", since: start.getTime(), until: now };
    }
  }
  const m = /^(\d{1,3})(h|d)$/.exec(w);
  if (m) {
    const n = Number(m[1]);
    const ms = m[2] === "h" ? n * 3_600_000 : n * DAY_MS;
    return { label: `last ${n}${m[2]}`, since: now - ms, until: now };
  }
  return null;
}

export interface SpendRow {
  key: string;
  costUsd: number;
  /** Some of the cost comes from the price table. */
  estimated: boolean;
  tokens: number;
  /** Tokens with no known price (the model wasn't reported). */
  unpricedTokens: number;
}

/** Usage rows in scope, counting a task's printed usage only when the
 *  task has no telemetry (telemetry is per request and more precise). */
const DEDUPED = sql`
  (source != 'task-output' OR task_ref IS NULL
   OR task_ref NOT IN (SELECT task_ref FROM agent_usage WHERE source = 'telemetry' AND task_ref IS NOT NULL))`;

export function spendBy(
  db: ForemanDb,
  groupBy: "department" | "agent" | "model",
  period: Period,
  agents?: readonly string[],
  /** Spend booked to this department or role when it happened. */
  booked?: { department?: string; role?: string },
): SpendRow[] {
  const column =
    groupBy === "department"
      ? sql`coalesce(department, '(no department)')`
      : groupBy === "agent"
        ? sql`agent_id`
        : sql`coalesce(model, '(unknown model)')`;
  const scope = booked?.department
    ? sql`AND department = ${booked.department}`
    : booked?.role
      ? sql`AND role = ${booked.role}`
      : agents
        ? sql`AND agent_id IN (${sql.join(agents.map((a) => sql`${a}`), sql`, `)})`
        : sql``;
  if (!booked && agents && agents.length === 0) return [];
  const rows = db.all<{ key: string; cost: number; est: number; tokens: number; unpriced: number }>(sql`
    SELECT ${column} AS key, sum(cost_usd) AS cost,
      max(CASE WHEN cost_estimated = 1 AND cost_usd > 0 THEN 1 ELSE 0 END) AS est, sum(total_tokens) AS tokens,
      sum(CASE WHEN cost_estimated = 1 AND cost_usd = 0 THEN total_tokens ELSE 0 END) AS unpriced
    FROM agent_usage
    WHERE ts >= ${period.since} AND ts < ${period.until + 1} AND ${DEDUPED} ${scope}
    GROUP BY key ORDER BY cost DESC, tokens DESC`);
  return rows.map((r) => ({
    key: r.key,
    costUsd: r.cost ?? 0,
    // Estimated only when the price table was actually applied.
    estimated: r.est === 1,
    tokens: r.tokens ?? 0,
    unpricedTokens: r.unpriced ?? 0,
  }));
}

/** Foreman's own LLM spend (summaries, verification, chat). */
export function foremanSpend(db: ForemanDb, period: Period): SpendRow | null {
  const row = db.get<{ cost: number | null; tokens: number | null }>(sql`
    SELECT sum(cost_usd) AS cost, sum(input_tokens + output_tokens) AS tokens
    FROM llm_usage WHERE ts >= ${period.since} AND ts < ${period.until + 1}`);
  if (!row?.tokens && !row?.cost) return null;
  return { key: "foreman", costUsd: row.cost ?? 0, estimated: false, tokens: row.tokens ?? 0, unpricedTokens: 0 };
}

export interface BudgetStatus {
  department: string;
  onExceed: "warn" | "pause";
  checks: Array<{ period: "day" | "month"; limitUsd: number; spentUsd: number }>;
  exceeded: boolean;
}

export function budgetStatus(
  db: ForemanDb,
  department: string,
  budget: OrgBudget,
  now: number = Date.now(),
): BudgetStatus {
  const checks: BudgetStatus["checks"] = [];
  const spent = (p: Period): number =>
    spendBy(db, "department", p).find((r) => r.key === department)?.costUsd ?? 0;
  if (budget.daily_usd) {
    checks.push({ period: "day", limitUsd: budget.daily_usd, spentUsd: spent(parsePeriod("today", now)!) });
  }
  if (budget.monthly_usd) {
    checks.push({ period: "month", limitUsd: budget.monthly_usd, spentUsd: spent(parsePeriod("month", now)!) });
  }
  return {
    department,
    onExceed: budget.on_exceed,
    checks,
    exceeded: checks.some((c) => c.spentUsd >= c.limitUsd),
  };
}

// -----------------------------------------------------------------------------
// The report
// -----------------------------------------------------------------------------

export interface OrgReport {
  target: { kind: "company" | "department" | "role" | "agent"; id: string; name: string };
  period: Period;
  spend: { costUsd: number; estimated: boolean; tokens: number; unpricedTokens: number };
  byDepartment: SpendRow[];
  byAgent: SpendRow[];
  foreman: SpendRow | null;
  tasks: { finished: number; failed: number; pending: number };
  toolCalls: { allowed: number; denied: number };
  costPerFinishedTask: number | null;
  budgets: BudgetStatus[];
  recent: Array<{ at: number; agent: string | null; title: string; detail: string }>;
}

export type ReportTarget =
  | { kind: "company" }
  | { kind: "department"; id: string }
  | { kind: "role"; id: string }
  | { kind: "agent"; id: string };

/** Resolve what the user typed: a department, a role, an agent, or nothing. */
export function resolveReportTarget(org: OrgDoc | null, word: string | undefined, knownAgents: readonly string[]): ReportTarget | null {
  if (!word || ["company", "all", "şirket", "sirket"].includes(word.toLowerCase())) return { kind: "company" };
  const id = word.toLowerCase();
  if (org && Object.hasOwn(org.departments, id)) return { kind: "department", id };
  if (org && Object.hasOwn(org.roles, id)) return { kind: "role", id };
  if (knownAgents.includes(id) || (org && rolesForAgent(org, id).length > 0)) return { kind: "agent", id };
  return null;
}

export function buildOrgReport(
  db: ForemanDb,
  org: OrgDoc | null,
  target: ReportTarget,
  period: Period,
  now: number = Date.now(),
  /** Include task output excerpts ("Latest results"). Only for you:
   *  agents asking through chat must not read other departments' work. */
  withResults = true,
): OrgReport {
  const agents = agentsInScope(org, target);
  const name =
    target.kind === "company"
      ? (org?.company ?? "Company")
      : target.kind === "department"
        ? (org?.departments[target.id]?.name ?? target.id)
        : target.kind === "role"
          ? (org?.roles[target.id]?.title ?? target.id)
          : target.id;
  // Spend is what was booked to the department / role when it happened,
  // the same numbers its budget sees; tasks and tool calls follow today's
  // chart.
  const booked =
    target.kind === "department" ? { department: target.id } : target.kind === "role" ? { role: target.id } : undefined;
  const byAgent = spendBy(db, "agent", period, agents ?? undefined, booked);
  const byDepartment = target.kind === "company" ? spendBy(db, "department", period) : [];
  const foreman = target.kind === "company" ? foremanSpend(db, period) : null;
  const rows = [...byAgent, ...(foreman ? [foreman] : [])];
  const spend = {
    costUsd: rows.reduce((s, r) => s + r.costUsd, 0),
    estimated: rows.some((r) => r.estimated),
    tokens: rows.reduce((s, r) => s + r.tokens, 0),
    unpricedTokens: rows.reduce((s, r) => s + r.unpricedTokens, 0),
  };
  const tasks = taskCounts(db, period, agents);
  const departments =
    target.kind === "company"
      ? Object.keys(org?.departments ?? {})
      : target.kind === "department"
        ? [target.id]
        : [];
  const budgets = departments
    .map((d) => ({ d, b: org?.departments[d]?.budget }))
    .filter((x): x is { d: string; b: OrgBudget } => Boolean(x.b))
    .map(({ d, b }) => budgetStatus(db, d, b, now));
  return {
    target: { kind: target.kind, id: "id" in target ? target.id : "company", name },
    period,
    spend,
    byDepartment,
    byAgent,
    foreman,
    tasks,
    toolCalls: toolCallCounts(db, period, agents),
    costPerFinishedTask: tasks.finished > 0 ? spend.costUsd / tasks.finished : null,
    budgets,
    recent: withResults ? recentResults(db, period, agents) : [],
  };
}

/** null = everyone (company view). */
function agentsInScope(org: OrgDoc | null, target: ReportTarget): string[] | null {
  switch (target.kind) {
    case "company":
      return null;
    case "agent":
      return [target.id];
    case "role": {
      const agent = org?.roles[target.id]?.agent;
      return agent ? [agent.toLowerCase()] : [];
    }
    case "department":
      return [
        ...new Set(
          Object.values(org?.roles ?? {})
            .filter((r) => r.department === target.id)
            .map((r) => r.agent.toLowerCase()),
        ),
      ];
  }
}

function inList(column: string, agents: string[] | null) {
  if (agents === null) return sql``;
  if (agents.length === 0) return sql`AND 0`;
  return sql`AND lower(${sql.raw(column)}) IN (${sql.join(agents.map((a) => sql`${a}`), sql`, `)})`;
}

function taskCounts(db: ForemanDb, period: Period, agents: string[] | null): OrgReport["tasks"] {
  const rows = db.all<{ status: string; n: number }>(sql`
    SELECT status, count(*) AS n FROM control_commands
    WHERE command = 'write' AND created_at >= ${period.since} AND created_at < ${period.until + 1}
      ${inList("json_extract(args, '$[0]')", agents)}
    GROUP BY status`);
  const n = (s: string[]): number => rows.filter((r) => s.includes(r.status)).reduce((a, r) => a + r.n, 0);
  return { finished: n(["applied"]), failed: n(["failed", "rejected"]), pending: n(["pending"]) };
}

function toolCallCounts(db: ForemanDb, period: Period, agents: string[] | null): OrgReport["toolCalls"] {
  const rows = db.all<{ decision: string; n: number }>(sql`
    SELECT decision, count(*) AS n FROM requests
    WHERE created_at >= ${period.since} AND created_at < ${period.until + 1} ${inList("source_agent", agents)}
    GROUP BY decision`);
  return {
    allowed: rows.find((r) => r.decision === "allowed")?.n ?? 0,
    denied: rows.find((r) => r.decision === "denied")?.n ?? 0,
  };
}

function recentResults(db: ForemanDb, period: Period, agents: string[] | null): OrgReport["recent"] {
  return db
    .all<{ at: number; agent: string | null; title: string; body: string }>(sql`
      SELECT created_at AS at, agent_id AS agent, title, body FROM inbox_items
      WHERE kind = 'delegation' AND created_at >= ${period.since} AND created_at < ${period.until + 1}
        ${inList("agent_id", agents)}
      ORDER BY created_at DESC LIMIT 5`)
    .map((r) => ({ at: r.at, agent: r.agent, title: r.title, detail: r.body }));
}

// -----------------------------------------------------------------------------
// Plain-text rendering (console, chat)
// -----------------------------------------------------------------------------

export function formatUsd(n: number, estimated = false): string {
  const v = n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3);
  return `${estimated ? "≈" : ""}$${v}`;
}

/** Cost cell for a row: `unpriced` when no token had a known price, and a
 *  trailing `+` when some did not. */
export function formatCost(r: Pick<SpendRow, "costUsd" | "estimated" | "tokens" | "unpricedTokens">): string {
  if (r.tokens > 0 && r.unpricedTokens >= r.tokens) return "unpriced";
  return `${formatUsd(r.costUsd, r.estimated)}${r.unpricedTokens > 0 ? "+" : ""}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function renderOrgReport(r: OrgReport): string {
  const lines: string[] = [];
  lines.push(`${r.target.name} · ${r.period.label}`);
  lines.push(
    `Spend ${formatUsd(r.spend.costUsd, r.spend.estimated)} · ${formatTokens(r.spend.tokens)} tokens` +
      (r.spend.unpricedTokens > 0 ? ` (${formatTokens(r.spend.unpricedTokens)} unpriced)` : "") +
      (r.costPerFinishedTask !== null && r.spend.unpricedTokens === 0
        ? ` · ${formatUsd(r.costPerFinishedTask, r.spend.estimated)} per finished task`
        : ""),
  );
  lines.push(
    `Tasks ${r.tasks.finished} finished, ${r.tasks.failed} failed` +
      (r.tasks.pending > 0 ? `, ${r.tasks.pending} waiting` : "") +
      ` · tool calls ${r.toolCalls.allowed} allowed, ${r.toolCalls.denied} blocked`,
  );
  for (const b of r.budgets) {
    for (const c of b.checks) {
      const pct = Math.round((c.spentUsd / c.limitUsd) * 100);
      const flag = c.spentUsd >= c.limitUsd ? (b.onExceed === "pause" ? " — over, paused" : " — over") : "";
      lines.push(`Budget ${b.department} (${c.period}): ${formatUsd(c.spentUsd)} of ${formatUsd(c.limitUsd)} (${pct}%)${flag}`);
    }
  }
  if (r.byDepartment.length > 0) {
    lines.push("", "By department");
    for (const d of r.byDepartment) lines.push(`  ${d.key.padEnd(18)} ${formatCost(d).padStart(9)}  ${formatTokens(d.tokens)} tokens`);
    if (r.foreman) lines.push(`  ${"foreman (itself)".padEnd(18)} ${formatUsd(r.foreman.costUsd).padStart(9)}  ${formatTokens(r.foreman.tokens)} tokens`);
  }
  if (r.byAgent.length > 0 && r.target.kind !== "agent") {
    lines.push("", "By agent");
    for (const a of r.byAgent.slice(0, 8)) lines.push(`  ${a.key.padEnd(18)} ${formatCost(a).padStart(9)}  ${formatTokens(a.tokens)} tokens`);
  }
  if (r.recent.length > 0) {
    lines.push("", "Latest results");
    for (const x of r.recent) lines.push(`  • ${x.title}${x.detail ? ` — ${x.detail.slice(0, 120)}` : ""}`);
  }
  if (r.spend.tokens === 0 && r.tasks.finished + r.tasks.failed === 0) {
    lines.push("", "Nothing recorded yet for this period. Spend is tracked from agent telemetry — see `foreman usage env <agent>`.");
  }
  return lines.join("\n");
}
