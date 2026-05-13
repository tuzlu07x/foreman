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
export type HaltReason = "turn_limit" | "token_limit" | "manual";

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

  startSession(participants: string[]): string {
    const id = ulid();
    this.db
      .insert(sessions)
      .values({
        id,
        participants: JSON.stringify(participants),
        startedAt: Date.now(),
        messageCount: 0,
        tokenCount: 0,
        status: "active",
      })
      .run();
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
    this.db
      .update(sessions)
      .set({ status: "completed", endedAt: Date.now() })
      .where(eq(sessions.id, sessionId))
      .run();
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
