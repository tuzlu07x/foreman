import type { RegisteredAgent } from "../core/registry.js";
import type { policies, Request } from "../db/schema.js";
import { formatDuration, formatTime } from "../tui/format.js";
import { dim, green, orange, red } from "./colors.js";

type PolicyRow = typeof policies.$inferSelect;

export function renderRequestLine(row: Request): string {
  const status =
    row.decision === "allowed"
      ? green("✓")
      : row.decision === "denied"
        ? red("✗")
        : orange("⚠");
  const target = row.targetAgent
    ? `${row.sourceAgent} → ${row.targetAgent}`
    : row.sourceAgent;
  const tool = row.targetTool ? row.targetTool : "(no tool)";
  const duration =
    row.durationMs !== null ? ` · ${formatDuration(row.durationMs)}` : "";
  return `${dim(`[${formatTime(row.createdAt)}]`)} ${orange(target)} ${tool} ${status} ${dim(`${row.decision}${row.decidedBy ? ` · ${row.decidedBy}` : ""}${duration}`)}`;
}

export function renderRequestJson(row: Request): unknown {
  return {
    id: row.id,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    sourceAgent: row.sourceAgent,
    targetAgent: row.targetAgent,
    targetTool: row.targetTool,
    args: safeParse(row.args),
    riskScore: row.riskScore,
    riskReasons: row.riskReasons ? safeParse(row.riskReasons) : [],
    riskFactors: row.riskFactors ? safeParse(row.riskFactors) : [],
    riskBucket: row.riskBucket,
    llmVerification: row.llmVerification ? safeParse(row.llmVerification) : null,
    decision: row.decision,
    decidedBy: row.decidedBy,
    durationMs: row.durationMs,
    result: row.result ? safeParse(row.result) : null,
  };
}

export function renderRequestDetail(row: Request): string {
  const lines = [
    `${orange("id")}            ${row.id}`,
    `${orange("created")}       ${formatTime(row.createdAt)}`,
    row.decidedAt
      ? `${orange("decided")}       ${formatTime(row.decidedAt)}${row.durationMs !== null ? ` (${formatDuration(row.durationMs)})` : ""}`
      : `${dim("decided       (pending)")}`,
    `${orange("source")}        ${row.sourceAgent}`,
    row.targetAgent ? `${orange("target")}        ${row.targetAgent}` : null,
    row.targetTool ? `${orange("tool")}          ${row.targetTool}` : null,
    `${orange("decision")}      ${row.decision}${row.decidedBy ? ` (${row.decidedBy})` : ""}`,
    `${orange("risk")}          ${row.riskScore}/100${row.riskBucket ? ` · ${row.riskBucket}` : ""}`,
    row.riskFactors
      ? `${orange("factors")}       ${formatFactors(row.riskFactors)}`
      : row.riskReasons
        ? `${orange("reasons")}       ${formatList(row.riskReasons)}`
        : null,
    "",
    orange("args"),
    indent(prettyJson(row.args)),
  ];
  if (row.result) {
    lines.push("", orange("result"), indent(prettyJson(row.result)));
  }
  return lines.filter((l) => l !== null).join("\n");
}

export function renderAgentLine(agent: RegisteredAgent): string {
  const dot =
    agent.status === "active"
      ? green("●")
      : agent.status === "blocked"
        ? red("●")
        : dim("○");
  const last = agent.lastSeenAt ? formatTime(agent.lastSeenAt) : "never";
  return `${dot} ${orange(agent.id)}  ${dim(agent.displayName)}  ${dim(`(${agent.transport})`)}  ${dim(`status=${agent.status} last=${last}`)}`;
}

export function renderAgentJson(agent: RegisteredAgent): unknown {
  return {
    id: agent.id,
    displayName: agent.displayName,
    transport: agent.transport,
    endpoint: agent.endpoint,
    status: agent.status,
    registeredAt: agent.registeredAt,
    lastSeenAt: agent.lastSeenAt,
    metadata: agent.metadata,
  };
}

export function renderPolicyLine(row: PolicyRow): string {
  const effect =
    row.effect === "allow"
      ? green("ALLOW")
      : row.effect === "deny"
        ? red("DENY")
        : orange("ASK");
  const enabled = row.enabled === 1 ? "" : dim(" DISABLED");
  return `${dim(`#${row.id}`)}  ${orange(row.sourceAgent)} ${dim("→")} ${row.target}  ${effect}${enabled}  ${dim(`(${row.createdBy})`)}`;
}

export function renderPolicyJson(row: PolicyRow): unknown {
  return {
    id: row.id,
    sourceAgent: row.sourceAgent,
    target: row.target,
    effect: row.effect,
    enabled: row.enabled === 1,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    conditions: row.conditions ? safeParse(row.conditions) : null,
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function prettyJson(text: string | null): string {
  if (!text) return "(empty)";
  const parsed = safeParse(text);
  return JSON.stringify(parsed, null, 2);
}

function indent(text: string, n = 2): string {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

function formatList(json: string): string {
  const parsed = safeParse(json);
  if (Array.isArray(parsed)) return parsed.join(", ");
  return json;
}

function formatFactors(json: string): string {
  const parsed = safeParse(json);
  if (!Array.isArray(parsed)) return json;
  return parsed
    .map((f) => {
      const obj = f as { rule?: unknown; points?: unknown; reason?: unknown };
      const rule = typeof obj.rule === "string" ? obj.rule : "?";
      const points = typeof obj.points === "number" ? obj.points : 0;
      const sign = points >= 0 ? "+" : "";
      const reason = typeof obj.reason === "string" ? ` — ${obj.reason}` : "";
      return `${sign}${points} ${rule}${reason}`;
    })
    .join("\n               ");
}
