import type { RegisteredAgent } from "../core/registry.js";
import { terminalSafe as t } from "../core/terminal-text.js";
import type { policies, Request } from "../db/schema.js";
import { fingerprint } from "../tui/boot-info.js";
import { formatDuration, formatTime, summariseTool } from "../tui/format.js";
import { dim, green, orange, red } from "./colors.js";

type PolicyRow = typeof policies.$inferSelect;

export function renderRequestLine(row: Request): string {
  const status =
    row.decision === "allowed"
      ? green("✓")
      : row.decision === "denied"
        ? red("✗")
        : orange("⚠");
  // Agent-supplied fields are shown with hidden characters made visible
  // (#656), before any colour codes of ours are added. The tool comes with
  // a short summary of its args, as the TUI Logs page shows it (#657):
  // `read_file("src/a.ts")`, `shell_exec(command="ls")`.
  const target = t(row.targetAgent ? `${row.sourceAgent} → ${row.targetAgent}` : row.sourceAgent);
  const tool = clipLine(summariseTool(row.targetTool, row.args), 80);
  const duration =
    row.durationMs !== null ? ` · ${formatDuration(row.durationMs)}` : "";
  return `${dim(`[${formatTime(row.createdAt)}]`)} ${orange(target)} ${tool} ${status} ${dim(`${row.decision}${row.decidedBy ? ` · ${t(row.decidedBy)}` : ""}${duration}`)}`;
}

function clipLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 2)}…)`;
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
    securityReport: row.securityReport ? safeParse(row.securityReport) : null,
    decision: row.decision,
    decidedBy: row.decidedBy,
    durationMs: row.durationMs,
    result: row.result ? safeParse(row.result) : null,
    // #301 — agent-to-agent flow tracking. Surfaced so JSON consumers
    // (jq pipelines, external dashboards) can reconstruct the chain.
    parentRequestId: row.parentRequestId ?? null,
    sessionId: row.sessionId ?? null,
  };
}

export function renderRequestDetail(row: Request): string {
  const lines = [
    `${orange("id")}            ${row.id}`,
    `${orange("created")}       ${formatTime(row.createdAt)}`,
    row.decidedAt
      ? `${orange("decided")}       ${formatTime(row.decidedAt)}${row.durationMs !== null ? ` (${formatDuration(row.durationMs)})` : ""}`
      : `${dim("decided       (pending)")}`,
    `${orange("source")}        ${t(row.sourceAgent)}`,
    row.targetAgent ? `${orange("target")}        ${t(row.targetAgent)}` : null,
    row.targetTool ? `${orange("tool")}          ${t(row.targetTool)}` : null,
    `${orange("decision")}      ${row.decision}${row.decidedBy ? ` (${t(row.decidedBy)})` : ""}`,
    `${orange("risk")}          ${row.riskScore}/100${row.riskBucket ? ` · ${row.riskBucket}` : ""}`,
    row.riskFactors
      ? `${orange("factors")}       ${formatFactors(row.riskFactors)}`
      : row.riskReasons
        ? `${orange("reasons")}       ${formatList(row.riskReasons)}`
        : null,
    // #301 — agent-to-agent lineage. Hidden when both are null so legacy
    // rows + single-shot calls don't get noisy " (none) " stubs.
    row.sessionId
      ? `${orange("session")}       ${row.sessionId}`
      : null,
    row.parentRequestId
      ? `${orange("parent")}        ${row.parentRequestId}`
      : null,
    "",
    orange("args"),
    indent(t(prettyJson(row.args), { multiline: true })),
  ];
  if (row.securityReport) {
    const summary = formatSecurityReport(row.securityReport);
    if (summary) lines.push("", orange("security report"), indent(summary));
  }
  if (row.result) {
    lines.push("", orange("result"), indent(t(prettyJson(row.result), { multiline: true })));
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
  return `${dot} ${orange(t(agent.id))}  ${dim(t(agent.displayName))}  ${dim(`(${agent.transport})`)}  ${dim(`status=${agent.status} last=${last}`)}`;
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

/** An agent's public key as `foreman agent show --json` prints it: the
 *  whole key in hex, plus the short fingerprint `foreman init` prints for
 *  Foreman's own key. Public material only. */
export function renderPublicKeyJson(publicKey: Buffer): {
  publicKey: string;
  publicKeyFingerprint: string;
} {
  return {
    publicKey: publicKey.toString("hex"),
    publicKeyFingerprint: `ed25519:${fingerprint(publicKey)}`,
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
  // #284-class polish (Bug G): show that a rule has conditions, so the
  // user understands why "the same target" can appear multiple times
  // (e.g. two `read_file` rules — one ASK for .env paths, one ALLOW for
  // everything else). Use `--json` to inspect the full condition body.
  const condTag = hasConditions(row.conditions) ? dim(" +cond") : "";
  return `${dim(`#${row.id}`)}  ${orange(t(row.sourceAgent))} ${dim("→")} ${t(row.target)}${condTag}  ${effect}${enabled}  ${dim(`(${row.createdBy})`)}`;
}

function hasConditions(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
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
  if (Array.isArray(parsed)) return t(parsed.join(", "));
  return t(json);
}

function formatSecurityReport(json: string): string | null {
  const parsed = safeParse(json);
  if (!parsed || typeof parsed !== "object") return null;
  const r = parsed as {
    oneLineSummary?: unknown;
    verdict?: { label?: unknown; icon?: unknown };
    narrative?: {
      whatHappening?: unknown;
      thingsToCheck?: unknown;
      recommendation?: unknown;
    };
    source?: unknown;
  };
  // The report quotes the call (paths, commands): #656.
  const out: string[] = [];
  if (r.verdict && typeof r.verdict.label === "string") {
    const icon = typeof r.verdict.icon === "string" ? `${r.verdict.icon} ` : "";
    out.push(t(`${icon}${r.verdict.label}`));
  }
  if (typeof r.oneLineSummary === "string") out.push(t(r.oneLineSummary));
  if (r.narrative && typeof r.narrative.whatHappening === "string") {
    out.push("", "what's happening:", indent(t(r.narrative.whatHappening, { multiline: true })));
  }
  if (r.narrative && Array.isArray(r.narrative.thingsToCheck)) {
    const items = r.narrative.thingsToCheck.filter(
      (x): x is string => typeof x === "string",
    );
    if (items.length > 0) {
      out.push("", "things to check:");
      for (const item of items) out.push(`  · ${t(item)}`);
    }
  }
  if (r.narrative && typeof r.narrative.recommendation === "string") {
    out.push("", `foreman → ${t(r.narrative.recommendation)}`);
  }
  if (typeof r.source === "string") out.push(dim(`source: ${t(r.source)}`));
  return out.length > 0 ? out.join("\n") : null;
}

function formatFactors(json: string): string {
  const parsed = safeParse(json);
  if (!Array.isArray(parsed)) return json;
  return parsed
    .map((f) => {
      const obj = f as { rule?: unknown; points?: unknown; reason?: unknown };
      const rule = typeof obj.rule === "string" ? t(obj.rule) : "?";
      const points = typeof obj.points === "number" ? obj.points : 0;
      const sign = points >= 0 ? "+" : "";
      const reason = typeof obj.reason === "string" ? ` — ${t(obj.reason)}` : "";
      return `${sign}${points} ${rule}${reason}`;
    })
    .join("\n               ");
}
