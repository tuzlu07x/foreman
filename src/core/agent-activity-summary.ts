import { and, desc, eq, gte, or } from "drizzle-orm";
import type { ForemanDb } from "../db/client.js";
import { auditEvents, requests, sessions } from "../db/schema.js";
import type { RegistryService } from "./registry.js";

// =============================================================================
// Agent activity digest (#435)
// =============================================================================
//
// Pure function: given a fixed DB snapshot + clock, returns the same
// digest. `/foreman report me` (#432) consumes a related snapshot
// optimized for LLM context; this digest is **structured + aggregated**
// for two consumers:
//
//   1. `foreman activity --since 1h --json` — debugging / scripting
//   2. Daily summary trigger — feeds the LLM prompt for proactive
//      "yesterday in your agents" narration
//
// Deterministic ordering: agents alphabetical, sessions newest-first,
// notable events newest-first. Window-bounded so the result is stable
// across runs as long as the underlying rows don't change.

export interface AgentActivityDigest {
  /** Snapshot window — `[start, end]` are absolute ms timestamps. */
  window: { start: number; end: number };
  /** Per-agent rollup. Includes every registered agent; agents with
   *  zero activity in the window get `requestCount=0` rows so the LLM
   *  can call out "OpenClaw was idle for 2h" type observations. */
  agents: Array<{
    id: string;
    displayName: string;
    /** Earliest `registeredAt` <= start, else null when agent was
     *  added during the window. */
    runningSince: number | null;
    requestCount: number;
    deniedCount: number;
    /** Latest request createdAt in the window, or null when idle. */
    lastActivityAt: number | null;
  }>;
  /** Sessions that started or had activity inside the window. */
  sessions: Array<{
    id: string;
    participants: string[];
    messageCount: number;
    tokenCount: number;
    startedAt: number;
    status: "active" | "completed" | "halted";
  }>;
  /** Hand-picked events worth surfacing: denials, crashes, budget
   *  alerts, high-risk decisions. Capped at 25 so the digest stays
   *  compact + fits in a Telegram message. */
  notableEvents: Array<NotableEvent>;
}

export type NotableEvent =
  | {
      kind: "denied";
      when: number;
      summary: string;
      sourceAgent: string;
      targetTool: string | null;
      riskScore: number;
    }
  | {
      kind: "crash";
      when: number;
      summary: string;
      agentId: string;
      exitCode: number;
    }
  | {
      kind: "budget-alert";
      when: number;
      summary: string;
      kindDetail: "threshold" | "exhausted";
      spentPct: number;
    }
  | {
      kind: "risk-high";
      when: number;
      summary: string;
      sourceAgent: string;
      targetTool: string | null;
      riskScore: number;
      decision: "allowed" | "denied" | "pending";
    };

export interface BuildDigestOptions {
  /** Window length in minutes. Default 60. */
  windowMinutes?: number;
  /** When set, only the agents-row + requests for that id are returned. */
  agentId?: string;
  /** Override Date.now (tests). */
  now?: () => number;
  /** Max notable events. Default 25. */
  maxNotable?: number;
}

const NOTABLE_CAP_DEFAULT = 25;
const HIGH_RISK_THRESHOLD = 70;

export function buildAgentActivityDigest(
  db: ForemanDb,
  registry: RegistryService,
  opts: BuildDigestOptions = {},
): AgentActivityDigest {
  const now = opts.now ? opts.now() : Date.now();
  const windowMinutes = opts.windowMinutes ?? 60;
  const start = now - windowMinutes * 60 * 1000;
  const maxNotable = opts.maxNotable ?? NOTABLE_CAP_DEFAULT;

  // Pull every request inside the window (optionally agent-filtered).
  // We aggregate in memory because the row count is bounded — a 1h
  // window typically caps at a few hundred even on busy setups.
  const baseQuery = db
    .select()
    .from(requests)
    .where(gte(requests.createdAt, start));
  const requestRows = opts.agentId
    ? db
        .select()
        .from(requests)
        .where(
          and(
            gte(requests.createdAt, start),
            or(
              eq(requests.sourceAgent, opts.agentId),
              eq(requests.targetAgent, opts.agentId),
            ),
          ),
        )
        .all()
    : baseQuery.all();

  // Per-agent rollup. Pre-seed with the registry so idle agents still
  // show up (`requestCount: 0`) — the LLM gets a complete roster.
  const registered = opts.agentId
    ? [registry.get(opts.agentId)].filter((a): a is NonNullable<typeof a> => a !== null)
    : registry.listAll();
  const sortedRegistered = [...registered].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const agents = sortedRegistered.map((a) => {
    const myRows = requestRows.filter(
      (r) => r.sourceAgent === a.id || r.targetAgent === a.id,
    );
    const denied = myRows.filter((r) => r.decision === "denied").length;
    const lastActivityAt = myRows.length > 0
      ? Math.max(...myRows.map((r) => r.createdAt))
      : null;
    return {
      id: a.id,
      displayName: a.displayName,
      runningSince: a.registeredAt <= start ? a.registeredAt : null,
      requestCount: myRows.length,
      deniedCount: denied,
      lastActivityAt,
    };
  });

  // Sessions touched in the window.
  const sessionRows = db
    .select()
    .from(sessions)
    .where(gte(sessions.startedAt, start))
    .orderBy(desc(sessions.startedAt))
    .limit(20)
    .all();
  const sessionsOut = sessionRows.map((s) => ({
    id: s.id,
    participants: parseParticipants(s.participants),
    messageCount: s.messageCount,
    tokenCount: s.tokenCount,
    startedAt: s.startedAt,
    status: s.status,
  }));

  // Notable events:
  //   - denied requests (always notable)
  //   - high-risk requests (riskScore >= 70) even when allowed
  //   - daemon crashes (from audit_events.event_type = 'agent_daemon_crashed')
  //   - budget alerts (audit_events.event_type = 'llm_budget_alert')
  const auditRows = db
    .select()
    .from(auditEvents)
    .where(gte(auditEvents.createdAt, start))
    .all();

  const notable: NotableEvent[] = [];

  for (const r of requestRows) {
    if (r.decision === "denied") {
      notable.push({
        kind: "denied",
        when: r.createdAt,
        summary: `${r.sourceAgent} → ${r.targetTool ?? r.targetAgent ?? "?"} (risk ${r.riskScore}) denied${r.decidedBy ? ` by ${r.decidedBy}` : ""}`,
        sourceAgent: r.sourceAgent,
        targetTool: r.targetTool,
        riskScore: r.riskScore,
      });
    } else if (r.riskScore >= HIGH_RISK_THRESHOLD) {
      notable.push({
        kind: "risk-high",
        when: r.createdAt,
        summary: `${r.sourceAgent} → ${r.targetTool ?? r.targetAgent ?? "?"} (risk ${r.riskScore}) ${r.decision}`,
        sourceAgent: r.sourceAgent,
        targetTool: r.targetTool,
        riskScore: r.riskScore,
        decision: r.decision,
      });
    }
  }

  for (const e of auditRows) {
    if (e.eventType === "agent_daemon_crashed") {
      try {
        const parsed = JSON.parse(e.payload) as Record<string, unknown>;
        const agentId =
          typeof parsed.agentId === "string" ? parsed.agentId : null;
        const exitCode =
          typeof parsed.exitCode === "number" ? parsed.exitCode : null;
        if (!agentId || exitCode === null) continue;
        const stderr =
          typeof parsed.stderr === "string" ? parsed.stderr : "";
        notable.push({
          kind: "crash",
          when: e.createdAt,
          summary: `${agentId} crashed (exit ${exitCode})${stderr ? `: ${stderr.split("\n")[0]?.slice(0, 80) ?? ""}` : ""}`,
          agentId,
          exitCode,
        });
      } catch {
        /* malformed JSON — skip */
      }
    } else if (e.eventType === "llm_budget_alert") {
      try {
        const parsed = JSON.parse(e.payload) as Record<string, unknown>;
        const kindDetail = parsed.kind;
        const spentPct =
          typeof parsed.spentPct === "number" ? parsed.spentPct : null;
        const spentUsd =
          typeof parsed.spentUsd === "number" ? parsed.spentUsd : null;
        const capUsd =
          typeof parsed.capUsd === "number" ? parsed.capUsd : null;
        if (
          (kindDetail !== "threshold" && kindDetail !== "exhausted") ||
          spentPct === null ||
          spentUsd === null ||
          capUsd === null
        ) {
          continue;
        }
        notable.push({
          kind: "budget-alert",
          when: e.createdAt,
          summary: `LLM budget ${kindDetail} — ${spentPct.toFixed(0)}% ($${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)})`,
          kindDetail,
          spentPct,
        });
      } catch {
        /* malformed JSON — skip */
      }
    }
  }

  // Newest first + cap.
  notable.sort((a, b) => b.when - a.when);
  const notableTrimmed = notable.slice(0, maxNotable);

  return {
    window: { start, end: now },
    agents,
    sessions: sessionsOut,
    notableEvents: notableTrimmed,
  };
}

function parseParticipants(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((p): p is string => typeof p === "string");
    }
    return [];
  } catch {
    return [];
  }
}
