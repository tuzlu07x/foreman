import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { ForemanDb } from "../db/client.js";
import { sessions } from "../db/schema.js";
import {
  bus as defaultBus,
  type EventBus,
  type ForemanEventMap,
} from "./event-bus.js";

const DEFAULT_TURN_LIMIT = 5;
const DEFAULT_TOKEN_LIMIT = 100_000;

export type SessionStatus = "active" | "completed" | "halted";
export type HaltReason =
  | "turn_limit"
  | "token_limit"
  | "manual"
  | "loop_detection";

export interface SessionInfo {
  id: string;
  participants: string[];
  startedAt: number;
  endedAt: number | null;
  messageCount: number;
  tokenCount: number;
  status: SessionStatus;
}

export interface RecordTurnResult {
  allowed: boolean;
  reason?: HaltReason;
  info: SessionInfo;
}

export interface SessionManagerOptions {
  turnLimit?: number;
  tokenLimit?: number;
  bus?: EventBus<ForemanEventMap>;
}

export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export class SessionManager {
  private readonly bus: EventBus<ForemanEventMap>;
  private readonly turnLimit: number;
  private readonly tokenLimit: number;

  constructor(
    private readonly db: ForemanDb,
    opts: SessionManagerOptions = {},
  ) {
    this.bus = opts.bus ?? defaultBus;
    this.turnLimit = opts.turnLimit ?? DEFAULT_TURN_LIMIT;
    this.tokenLimit = opts.tokenLimit ?? DEFAULT_TOKEN_LIMIT;
  }

  startSession(
    participants: string[],
    opts: { trigger?: string; estimatedTurns?: number } = {},
  ): string {
    const id = ulid();
    const startedAt = Date.now();
    this.db
      .insert(sessions)
      .values({
        id,
        participants: JSON.stringify(participants),
        startedAt,
        messageCount: 0,
        tokenCount: 0,
        status: "active",
      })
      .run();
    // #523 — lifecycle push so the notification bridge can tell the user
    // "▶️ openclaw çalışmaya başladı" without polling. Trigger defaults to
    // "unknown" so callers that haven't been updated still get a coherent
    // event payload.
    this.bus.emit("session:started", {
      sessionId: id,
      participants,
      trigger: opts.trigger ?? "unknown",
      estimatedTurns: opts.estimatedTurns,
      startedAt,
    });
    return id;
  }

  recordTurn(sessionId: string, tokenCount = 0): RecordTurnResult {
    const current = this.requireSession(sessionId);
    if (current.status !== "active") {
      const reason = current.status === "halted" ? "manual" : undefined;
      return { allowed: false, reason, info: current };
    }
    const nextMessages = current.messageCount + 1;
    const nextTokens = current.tokenCount + tokenCount;

    const overTurn = nextMessages > this.turnLimit;
    const overTokens = nextTokens > this.tokenLimit;
    if (overTurn || overTokens) {
      const reason: HaltReason = overTurn ? "turn_limit" : "token_limit";
      this.markHalted(
        sessionId,
        reason,
        current.messageCount,
        current.tokenCount,
      );
      const refreshed = this.requireSession(sessionId);
      return { allowed: false, reason, info: refreshed };
    }

    this.db
      .update(sessions)
      .set({ messageCount: nextMessages, tokenCount: nextTokens })
      .where(eq(sessions.id, sessionId))
      .run();
    return { allowed: true, info: this.requireSession(sessionId) };
  }

  halt(sessionId: string, reason: HaltReason = "manual"): void {
    const current = this.get(sessionId);
    if (!current || current.status !== "active") return;
    this.markHalted(
      sessionId,
      reason,
      current.messageCount,
      current.tokenCount,
    );
  }

  complete(sessionId: string): void {
    const current = this.get(sessionId);
    if (!current) return;
    // Don't double-complete (e.g. complete() after halt()) — the halt path
    // already emitted its lifecycle event with outcome:'halted'.
    if (current.status !== "active") return;
    const completedAt = Date.now();
    this.db
      .update(sessions)
      .set({ status: "completed", endedAt: completedAt })
      .where(eq(sessions.id, sessionId))
      .run();
    // #523 — costUsd is a placeholder until the per-session cost rollup
    // (#530) wires the `llm_usage.session_id` column. The notification
    // template renders "$0.00" until then, which matches the in-flight
    // "we don't know yet" UX.
    this.bus.emit("session:completed", {
      sessionId,
      outcome: "success",
      turnCount: current.messageCount,
      tokenCount: current.tokenCount,
      costUsd: 0,
      durationMs: completedAt - current.startedAt,
      completedAt,
    });
  }

  get(sessionId: string): SessionInfo | null {
    const row = this.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    return row ? this.toInfo(row) : null;
  }

  getActive(): SessionInfo[] {
    return this.db
      .select()
      .from(sessions)
      .where(eq(sessions.status, "active"))
      .all()
      .map((r) => this.toInfo(r));
  }

  list(): SessionInfo[] {
    return this.db
      .select()
      .from(sessions)
      .all()
      .map((r) => this.toInfo(r))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  isHalted(sessionId: string): boolean {
    return this.get(sessionId)?.status === "halted";
  }

  private markHalted(
    sessionId: string,
    reason: HaltReason,
    turnCount: number,
    tokenCount: number,
  ): void {
    const haltedAt = Date.now();
    const current = this.get(sessionId);
    this.db
      .update(sessions)
      .set({ status: "halted", endedAt: haltedAt })
      .where(eq(sessions.id, sessionId))
      .run();
    this.bus.emit("session:halted", {
      sessionId,
      reason,
      turnCount,
      tokenCount,
      haltedAt,
    });
    // #523 — Halt also completes the session from the user's POV; emit the
    // lifecycle event so the notification bridge can render the "⚠ halted"
    // push without subscribing to two separate event types. Kept alongside
    // session:halted (not replacing it) because existing listeners — the
    // audit log + loop-detection counters — depend on the halt-specific
    // shape.
    if (current) {
      this.bus.emit("session:completed", {
        sessionId,
        outcome: "halted",
        reason,
        turnCount,
        tokenCount,
        costUsd: 0,
        durationMs: haltedAt - current.startedAt,
        completedAt: haltedAt,
      });
    }
  }

  private requireSession(sessionId: string): SessionInfo {
    const info = this.get(sessionId);
    if (!info) throw new SessionNotFoundError(sessionId);
    return info;
  }

  private toInfo(row: typeof sessions.$inferSelect): SessionInfo {
    return {
      id: row.id,
      participants: JSON.parse(row.participants) as string[],
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      messageCount: row.messageCount,
      tokenCount: row.tokenCount,
      status: row.status,
    };
  }
}
