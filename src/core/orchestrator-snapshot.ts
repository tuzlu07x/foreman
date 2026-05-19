import { and, desc, eq, gte, or } from "drizzle-orm";
import type { ForemanDb } from "../db/client.js";
import { requests, sessions } from "../db/schema.js";
import type { RegistryService } from "./registry.js";

// =============================================================================
// Orchestrator snapshot (#432)
// =============================================================================
//
// Foreman's LLM needs a focused, deterministic context to answer
// `/foreman report me` and `/foreman <agent> ne yapıyor`. This module
// builds it: last N audit-log rows, active sessions, agent roster
// snapshots — all bounded so the prompt stays well under the token
// budget. The snapshot is JSON-serializable so the prompt template can
// embed it directly.
//
// Per the issue: "NOT the whole audit log — token budget matters".
// Default N = 30. Caller can override via `lastN`. We also filter by
// agentId when the user is asking about one specific agent.

export interface OrchestratorSnapshot {
  /** Wall-clock window the snapshot covers — [oldestRow.createdAt, now]. */
  windowMs: { start: number; end: number };
  /** Last N requests, newest first. Args is parsed to a short string
   *  representation; we don't dump the full payload. */
  recentRequests: Array<{
    requestId: string;
    sourceAgent: string;
    targetAgent: string | null;
    targetTool: string | null;
    decision: "allowed" | "denied" | "pending";
    decidedBy: string | null;
    riskScore: number;
    riskBucket: "low" | "medium" | "high" | "critical" | null;
    createdAt: number;
    durationMs: number | null;
  }>;
  /** Sessions touched in the window — participants + counts so the LLM
   *  can narrate "Hermes talked to OpenClaw 4 times". */
  activeSessions: Array<{
    id: string;
    participants: string[];
    status: "active" | "completed" | "halted";
    messageCount: number;
    tokenCount: number;
    startedAt: number;
  }>;
  /** Every registered agent + its high-level state. The LLM uses this
   *  to mention agents the user might not have asked about — e.g.
   *  "OpenClaw has been idle for 2h". */
  agents: Array<{
    id: string;
    displayName: string;
    status: "active" | "inactive" | "blocked" | "disabled";
    lastSeenAt: number | null;
    responsibilityNote: string | null;
  }>;
  /** When the snapshot was built. LLM uses this to anchor relative
   *  phrasing like "5 minutes ago". */
  capturedAt: number;
}

export interface BuildSnapshotOptions {
  /** Bound the request count. Default 30 — the issue's spec value. */
  lastN?: number;
  /** When set, only include requests where source or target == agentId.
   *  Used by `/foreman <agent> ne yapıyor`. */
  agentId?: string;
  /** Override for tests; defaults to Date.now(). */
  now?: () => number;
}

export function buildOrchestratorSnapshot(
  db: ForemanDb,
  registry: RegistryService,
  opts: BuildSnapshotOptions = {},
): OrchestratorSnapshot {
  const lastN = opts.lastN ?? 30;
  const now = opts.now ? opts.now() : Date.now();

  // Pull last N requests (optionally filtered by agentId on source or target).
  const requestsQuery = opts.agentId
    ? db
        .select()
        .from(requests)
        .where(
          or(
            eq(requests.sourceAgent, opts.agentId),
            eq(requests.targetAgent, opts.agentId),
          ),
        )
        .orderBy(desc(requests.createdAt))
        .limit(lastN)
    : db
        .select()
        .from(requests)
        .orderBy(desc(requests.createdAt))
        .limit(lastN);
  const requestRows = requestsQuery.all();

  // Sessions started in roughly the same window. Cap to last 20 — usually
  // far fewer than that anyway. Filter is `startedAt >= oldestRequest`
  // when we have one; else last 24h.
  const oldestRequestAt =
    requestRows.length > 0
      ? requestRows[requestRows.length - 1]!.createdAt
      : now - 24 * 60 * 60 * 1000;
  const sessionRows = db
    .select()
    .from(sessions)
    .where(gte(sessions.startedAt, oldestRequestAt))
    .orderBy(desc(sessions.startedAt))
    .limit(20)
    .all();

  const registered = registry.listAll();

  return {
    windowMs: { start: oldestRequestAt, end: now },
    recentRequests: requestRows.map((r) => ({
      requestId: r.id,
      sourceAgent: r.sourceAgent,
      targetAgent: r.targetAgent,
      targetTool: r.targetTool,
      decision: r.decision,
      decidedBy: r.decidedBy,
      riskScore: r.riskScore,
      riskBucket: r.riskBucket,
      createdAt: r.createdAt,
      durationMs: r.durationMs,
    })),
    activeSessions: sessionRows.map((s) => ({
      id: s.id,
      participants: parseJsonArray(s.participants),
      status: s.status,
      messageCount: s.messageCount,
      tokenCount: s.tokenCount,
      startedAt: s.startedAt,
    })),
    agents: registered.map((a) => ({
      id: a.id,
      displayName: a.displayName,
      status: a.status,
      lastSeenAt: a.lastSeenAt,
      responsibilityNote: a.responsibilityNote,
    })),
    capturedAt: now,
  };
}

function parseJsonArray(raw: string): string[] {
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

// =============================================================================
// Prompt rendering
// =============================================================================
//
// Compact, structured. The LLM gets the snapshot as a JSON-ish summary
// inside a system-role-like preamble, then the user's question. Output
// constraint: 1-3 short paragraphs, plain text (no markdown headers).

export interface BuildPromptArgs {
  snapshot: OrchestratorSnapshot;
  /** What the user actually asked. For `/foreman report me`, default to
   *  "What have the agents been doing? Give me a quick status report." */
  question: string;
  /** Optional agent focus — set when the user asked about one agent. */
  focusAgentId?: string;
}

export function buildOrchestratorPrompt(args: BuildPromptArgs): string {
  const snap = args.snapshot;
  const ageMin = Math.max(
    1,
    Math.round((snap.capturedAt - snap.windowMs.start) / 60_000),
  );

  const agentLines = snap.agents.map((a) => {
    const lastSeen = a.lastSeenAt
      ? `last seen ${describeAgo(snap.capturedAt - a.lastSeenAt)}`
      : "never seen";
    const note = a.responsibilityNote
      ? ` — role: ${a.responsibilityNote}`
      : "";
    return `  - ${a.id} (${a.displayName}, ${a.status}, ${lastSeen})${note}`;
  });

  const requestLines = snap.recentRequests.slice(0, 30).map((r) => {
    const target = r.targetTool ?? r.targetAgent ?? "(none)";
    const risk = r.riskBucket ?? "?";
    return `  - ${describeAgo(snap.capturedAt - r.createdAt)}: ${r.sourceAgent} → ${target} (${r.decision}, risk=${r.riskScore}/${risk})`;
  });

  const sessionLines = snap.activeSessions.slice(0, 10).map((s) => {
    return `  - ${s.id} (${s.status}, ${s.participants.join(" + ")}, ${s.messageCount} msgs / ${s.tokenCount} tokens)`;
  });

  const focusLine = args.focusAgentId
    ? `User's question is about agent **${args.focusAgentId}** specifically. Center the response on it; mention others only when relevant.`
    : "User asked for a general status. Cover the most active agents + any notable risk decisions.";

  return [
    "You are Foreman — a guardian that supervises a small team of AI agents.",
    "Your job: give the user a tight, factual status update based on the snapshot below.",
    "Reply in 1-3 short paragraphs. Plain text, no markdown headers, no lists.",
    "Match the user's language (if they wrote in Turkish, reply in Turkish; English otherwise).",
    "",
    focusLine,
    "",
    `Snapshot captured ${ageMin}m of activity (up to ${new Date(snap.capturedAt).toISOString()}).`,
    "",
    "Registered agents:",
    agentLines.length > 0 ? agentLines.join("\n") : "  (none)",
    "",
    `Recent requests (${snap.recentRequests.length}, newest first):`,
    requestLines.length > 0 ? requestLines.join("\n") : "  (none)",
    "",
    `Active sessions (${snap.activeSessions.length}):`,
    sessionLines.length > 0 ? sessionLines.join("\n") : "  (none)",
    "",
    "User's question:",
    args.question,
    "",
    "Your reply:",
  ].join("\n");
}

// Same compact "Xs / Xm / Xh ago" used in the foreman-command status
// handler. Pulled inline here to avoid a cross-module dependency.
function describeAgo(ms: number): string {
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
