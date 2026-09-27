import { and, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { monotonicFactory } from "ulid";
import type { ForemanDb } from "../db/client.js";
import { inboxItems, pendingApprovals, requests, type InboxItem } from "../db/schema.js";
import type { EventBus, ForemanEventMap } from "./event-bus.js";
import { redactSecretShapes } from "./risk-rules/secret-patterns.js";

// =============================================================================
// Inbox — what the TUI notification centre shows (#613)
// =============================================================================
//
// External channels (Telegram, Slack, email, …) are optional; the inbox is
// not. Everything the user should know about lands here, persisted with a
// read flag, so the TUI can show what happened while they were away and a
// fresh install with no channels still has a place for alerts.
//
// The recorder listens on the in-process bus and, for events that happen in
// other processes (an agent's `foreman mcp-stdio`, the Claude Code hook),
// polls the audit table. A dedupe key makes the two sources converge.

export type InboxLevel = InboxItem["level"];
export type InboxKind = InboxItem["kind"];

export interface NewInboxEntry {
  level: InboxLevel;
  kind: InboxKind;
  title: string;
  body?: string;
  requestId?: string | null;
  agentId?: string | null;
  dedupeKey?: string | null;
  /** Mark as already read (e.g. the user resolved it in the TUI). */
  read?: boolean;
  createdAt?: number;
}

/** Items created in the same millisecond still sort in insertion order. */
const nextId = monotonicFactory();

const MAX_TITLE = 160;
const MAX_BODY = 600;
const KEEP_ITEMS = 1_000;

export class InboxService {
  constructor(
    private readonly db: ForemanDb,
    private readonly bus?: EventBus<ForemanEventMap>,
  ) {}

  /** Insert an item; returns null when the dedupe key already exists. */
  add(entry: NewInboxEntry): InboxItem | null {
    const now = entry.createdAt ?? Date.now();
    const row = {
      id: nextId(now),
      createdAt: now,
      level: entry.level,
      kind: entry.kind,
      title: clip(redactSecretShapes(entry.title).text, MAX_TITLE),
      body: clip(redactSecretShapes(entry.body ?? "").text, MAX_BODY),
      requestId: entry.requestId ?? null,
      agentId: entry.agentId ?? null,
      dedupeKey: entry.dedupeKey ?? null,
      readAt: entry.read ? now : null,
    };
    const result = this.db.insert(inboxItems).values(row).onConflictDoNothing().run();
    if (result.changes === 0) return null;
    this.bus?.emit("inbox:added", { item: row });
    return row;
  }

  list(opts: { limit?: number; unreadOnly?: boolean; minLevel?: InboxLevel } = {}): InboxItem[] {
    const conditions = [];
    if (opts.unreadOnly) conditions.push(isNull(inboxItems.readAt));
    if (opts.minLevel && opts.minLevel !== "info") {
      conditions.push(
        inArray(inboxItems.level, opts.minLevel === "critical" ? ["critical"] : ["warning", "critical"]),
      );
    }
    return this.db
      .select()
      .from(inboxItems)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(inboxItems.createdAt), desc(inboxItems.id))
      .limit(opts.limit ?? 200)
      .all();
  }

  unreadCount(): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(inboxItems)
      .where(isNull(inboxItems.readAt))
      .get();
    return row?.n ?? 0;
  }

  markRead(id: string): void {
    this.db
      .update(inboxItems)
      .set({ readAt: Date.now() })
      .where(and(eq(inboxItems.id, id), isNull(inboxItems.readAt)))
      .run();
    this.bus?.emit("inbox:read", { ids: [id] });
  }

  markAllRead(): number {
    const result = this.db
      .update(inboxItems)
      .set({ readAt: Date.now() })
      .where(isNull(inboxItems.readAt))
      .run();
    this.bus?.emit("inbox:read", { ids: [] });
    return result.changes;
  }

  /** Mark the items about one request read (it has been dealt with). */
  markRequestRead(requestId: string): void {
    this.db
      .update(inboxItems)
      .set({ readAt: Date.now() })
      .where(and(eq(inboxItems.requestId, requestId), isNull(inboxItems.readAt)))
      .run();
    this.bus?.emit("inbox:read", { ids: [] });
  }

  /** Keep the newest `keep` items. */
  prune(keep = KEEP_ITEMS): void {
    const cutoff = this.db
      .select({ createdAt: inboxItems.createdAt })
      .from(inboxItems)
      .orderBy(desc(inboxItems.createdAt))
      .limit(1)
      .offset(keep)
      .get();
    if (!cutoff) return;
    this.db.delete(inboxItems).where(lte(inboxItems.createdAt, cutoff.createdAt)).run();
  }
}

// -----------------------------------------------------------------------------
// Recorder
// -----------------------------------------------------------------------------

export interface InboxRecorderOptions {
  bus: EventBus<ForemanEventMap>;
  /** How often to scan the audit table for blocks decided in other
   *  processes. */
  pollIntervalMs?: number;
  now?: () => number;
}

const DEFAULT_POLL_MS = 2_000;

export class InboxRecorder {
  private readonly offs: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;
  private watermark: number;
  private readonly approvalMeta = new Map<string, { agent: string; tool: string }>();
  private readonly pollIntervalMs: number;

  constructor(
    private readonly db: ForemanDb,
    private readonly inbox: InboxService,
    private readonly opts: InboxRecorderOptions,
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.watermark = (opts.now ?? Date.now)();
  }

  start(): void {
    if (this.timer) return;
    const { bus } = this.opts;
    this.offs.push(
      bus.on("approval:requested", (e) => {
        const tool = e.targetTool ?? e.targetAgent ?? "a tool";
        this.approvalMeta.set(e.requestId, { agent: e.sourceAgent, tool });
        this.inbox.add({
          level: e.riskBucket === "critical" ? "critical" : "warning",
          kind: "approval",
          title: `Approval needed: ${e.sourceAgent} → ${tool}`,
          body: [`risk ${e.riskScore} (${e.riskBucket})`, ...e.riskReasons.slice(0, 3)].join(" · "),
          requestId: e.requestId,
          agentId: e.sourceAgent,
          dedupeKey: `approval:${e.requestId}:requested`,
        });
      }),
      bus.on("approval:resolved", (e) => {
        const meta = this.approvalMeta.get(e.requestId) ?? this.lookupApproval(e.requestId);
        this.approvalMeta.delete(e.requestId);
        // The request itself is handled either way.
        this.inbox.markRequestRead(e.requestId);
        const what = meta ? `${meta.tool} for ${meta.agent}` : e.requestId;
        const verb = e.decision === "allowed" ? "Allowed" : "Denied";
        const who =
          e.resolvedBy === "timeout"
            ? "nobody answered in time"
            : e.via === "tui"
              ? "by you in the TUI"
              : e.via === "agent_mcp"
                ? `by you, relayed by ${e.routedBy ?? "your chat agent"}`
                : e.via
                  ? `by you via ${e.via[0]!.toUpperCase()}${e.via.slice(1)}`
                  : "by you";
        this.inbox.add({
          level: e.resolvedBy === "timeout" ? "warning" : "info",
          kind: "approval",
          title: `${verb} ${what}`,
          body: who + (e.remember ? ` · remembered as always ${e.remember}` : ""),
          requestId: e.requestId,
          agentId: meta?.agent ?? null,
          dedupeKey: `approval:${e.requestId}:resolved`,
          // A decision the user just made in the TUI needs no reminder.
          read: e.via === "tui" || (e.resolvedBy === "user" && e.via === undefined),
        });
      }),
      bus.on("request:decided", (e) => {
        if (e.decision !== "denied" || e.decidedBy.startsWith("user")) return;
        this.recordBlock({
          id: e.requestId,
          agent: e.sourceAgent,
          tool: e.targetTool ?? e.targetAgent ?? "a tool",
          decidedBy: e.decidedBy,
          bucket: e.riskBucket,
          reasons: e.riskReasons,
          at: e.decidedAt,
        });
      }),
      bus.on("llm:budget-alert", (e) => {
        this.inbox.add({
          level: e.kind === "exhausted" ? "critical" : "warning",
          kind: "budget",
          title:
            e.kind === "exhausted"
              ? "LLM budget exhausted"
              : `LLM budget ${e.spentPct.toFixed(0)}% spent`,
          body: `$${e.spentUsd.toFixed(2)} of $${e.capUsd.toFixed(2)} · resets in ${e.daysUntilReset} day(s)`,
          dedupeKey: `budget:${e.kind}:${e.windowStart}`,
        });
      }),
      bus.on("agent:daemon-crashed", (e) => {
        const hint = e.stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
        this.inbox.add({
          level: "critical",
          kind: "agent",
          title: `${e.agentId} crashed (exit ${e.exitCode})`,
          body: hint,
          agentId: e.agentId,
          dedupeKey: `crash:${e.agentId}:${e.crashedAt}`,
        });
      }),
      bus.on("session:halted", (e) => {
        // Only protective halts are news; "manual" is also how a finished
        // task's session is closed.
        if (e.reason === "manual") return;
        this.inbox.add({
          level: "warning",
          kind: "agent",
          title: `Session halted: ${e.reason.replace(/_/g, " ")}`,
          body: `${e.turnCount} turns · ${e.tokenCount} tokens`,
          dedupeKey: `halt:${e.sessionId}`,
        });
      }),
      bus.on("control:failed", (e) => {
        // `write` outcomes are recorded with the agent's output by the
        // drain handler in `foreman start`.
        if (e.command === "write") return;
        this.inbox.add({
          level: "warning",
          kind: "delegation",
          title: `'${e.command}' from ${e.sourceAgent} ${e.status}`,
          body: e.error,
          agentId: e.sourceAgent,
          dedupeKey: `control:${e.id}:failed`,
        });
      }),
      bus.on("update:available", (e) => {
        this.inbox.add({
          level: "info",
          kind: "update",
          title: `Foreman ${e.latest} is available`,
          body: `You have ${e.current}. Run: npm install -g foreman-agent@latest`,
          dedupeKey: `update:foreman:${e.latest}`,
        });
      }),
      bus.on("agent-update:available", (e) => {
        for (const u of e.updates) {
          this.inbox.add({
            level: "info",
            kind: "update",
            title: `${u.displayName} ${u.latest} is available`,
            body: `You have ${u.current}. Run: foreman agents update ${u.id}`,
            agentId: u.id,
            dedupeKey: `update:${u.id}:${u.latest}`,
          });
        }
      }),
    );
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Blocks decided in other processes only reach this one through the
   *  audit table. Exposed for tests. */
  poll(): void {
    const rows = this.db
      .select({
        id: requests.id,
        sourceAgent: requests.sourceAgent,
        targetAgent: requests.targetAgent,
        targetTool: requests.targetTool,
        decidedBy: requests.decidedBy,
        riskBucket: requests.riskBucket,
        riskReasons: requests.riskReasons,
        createdAt: requests.createdAt,
        decidedAt: requests.decidedAt,
      })
      .from(requests)
      .where(and(eq(requests.decision, "denied"), gt(requests.createdAt, this.watermark)))
      .orderBy(requests.createdAt)
      .limit(200)
      .all();
    for (const r of rows) {
      this.watermark = Math.max(this.watermark, r.createdAt);
      if (!r.decidedBy || r.decidedBy.startsWith("user")) continue;
      this.recordBlock({
        id: r.id,
        agent: r.sourceAgent,
        tool: r.targetTool ?? r.targetAgent ?? "a tool",
        decidedBy: r.decidedBy,
        bucket: r.riskBucket ?? "medium",
        reasons: parseReasons(r.riskReasons),
        at: r.decidedAt ?? r.createdAt,
      });
    }
    this.inbox.prune();
  }

  private recordBlock(b: {
    id: string;
    agent: string;
    tool: string;
    decidedBy: string;
    bucket: string;
    reasons: string[];
    at: number;
  }): void {
    const timedOut = b.decidedBy === "approval-timeout";
    const cancelled = b.decidedBy === "approval-cancelled";
    // Timeouts and cancellations are reported by the approval item itself.
    if (cancelled) return;
    this.inbox.add({
      level: b.bucket === "critical" ? "critical" : "warning",
      kind: "block",
      title: timedOut
        ? `Denied ${b.tool} for ${b.agent} (no answer in time)`
        : `Blocked ${b.tool} from ${b.agent}`,
      body: [describeDecider(b.decidedBy), ...b.reasons.slice(0, 3)].join(" · "),
      requestId: b.id,
      agentId: b.agent,
      dedupeKey: timedOut ? `approval:${b.id}:resolved` : `block:${b.id}`,
      createdAt: b.at,
    });
  }

  private lookupApproval(requestId: string): { agent: string; tool: string } | null {
    const row = this.db
      .select({
        sourceAgent: pendingApprovals.sourceAgent,
        targetTool: pendingApprovals.targetTool,
        targetAgent: pendingApprovals.targetAgent,
      })
      .from(pendingApprovals)
      .where(eq(pendingApprovals.requestId, requestId))
      .get();
    if (!row) return null;
    return { agent: row.sourceAgent, tool: row.targetTool ?? row.targetAgent ?? "a tool" };
  }
}

function describeDecider(decidedBy: string): string {
  if (decidedBy.startsWith("policy:")) return "policy rule";
  if (decidedBy.startsWith("risk:")) return `risk ${decidedBy.slice("risk:".length)}`;
  if (decidedBy.startsWith("agent:")) return `agent is ${decidedBy.slice("agent:".length)}`;
  if (decidedBy === "approval-timeout") return "approval timed out";
  return decidedBy;
}

function parseReasons(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

// -----------------------------------------------------------------------------
// Delegation outcomes
// -----------------------------------------------------------------------------

/** How a `write` spawn ended (structural subset of the executor's result). */
export type DelegationSpawn =
  | { kind: "ok"; stdout: string }
  | { kind: "failed"; exitCode: number; stdout: string; stderr: string }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "spawn-error"; error: string }
  | { kind: "unsupported"; reason: string };

export function oneLineSummary(text: string, max: number): string {
  return clip(text, max);
}

/** Inbox item for a finished task: what the agent said, or why it failed.
 *  Written by the drain handler in `foreman start`. */
export function recordDelegationOutcome(
  inbox: InboxService,
  input: { controlId: number; agentId: string; task: string; spawn: DelegationSpawn },
): InboxItem | null {
  const { spawn, agentId } = input;
  const task = clip(input.task, 60);
  const tail = (text: string): string => clip(text.trim().split("\n").slice(-4).join(" "), 300);
  let title: string;
  let body: string;
  switch (spawn.kind) {
    case "ok":
      title = `${agentId} finished: ${task}`;
      body = tail(spawn.stdout) || "(no output)";
      break;
    case "failed":
      title = `${agentId} failed (exit ${spawn.exitCode}): ${task}`;
      body = tail(spawn.stderr || spawn.stdout);
      break;
    case "timeout":
      title = `${agentId} timed out: ${task}`;
      body = `Stopped after ${Math.round(spawn.timeoutMs / 1000)}s.`;
      break;
    case "spawn-error":
      title = `Couldn't start ${agentId}: ${task}`;
      body = spawn.error;
      break;
    default:
      title = `${agentId} can't run tasks yet: ${task}`;
      body = spawn.reason;
  }
  return inbox.add({
    level: spawn.kind === "ok" ? "info" : "warning",
    kind: "delegation",
    title,
    body,
    agentId,
    dedupeKey: `control:${input.controlId}:outcome`,
  });
}
