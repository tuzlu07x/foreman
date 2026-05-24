import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { ForemanDb } from "../db/client.js";
import { sessions } from "../db/schema.js";
import type { ControlChannel } from "./control-channel.js";
import {
  bus as defaultBus,
  type EventBus,
  type ForemanEventMap,
  type SessionResolutionPayload,
} from "./event-bus.js";
import {
  fallbackContextSummary,
  findOption,
  templateForHaltReason,
  type ResolutionOption,
} from "./session-resolution-templates.js";

const DEFAULT_TURN_LIMIT = 5;
const DEFAULT_TOKEN_LIMIT = 100_000;
// #527 — How long the user has to pick a resolution option before the
// session auto-abandons. Mirrors the approval timeout default (10 min)
// so the UX cadence is consistent across "approve this call" and
// "resolve this halt" prompts.
const DEFAULT_RESOLUTION_TIMEOUT_MS = 10 * 60_000;

export type SessionStatus = "active" | "completed" | "halted";
export type HaltReason =
  | "turn_limit"
  | "token_limit"
  | "manual"
  | "loop_detection";

/** #527 — Sub-state of `halted`. NULL on the SessionInfo means the halt
 *  isn't waiting for a user resolution (manual halts, halts that have
 *  already been resolved + consumed). */
export type ResolutionStatus =
  | "needed"
  | "provided"
  | "consumed"
  | "expired";

/** #527 — Persisted record of a user's resolution choice. Stored on
 *  sessions.resolution_payload so audits + the bridge can replay what
 *  was picked. */
export interface ResolutionRecord {
  optionId: string;
  payload: SessionResolutionPayload;
  providedAt: number;
  providedBy?: string;
}

export interface SessionInfo {
  id: string;
  participants: string[];
  startedAt: number;
  endedAt: number | null;
  messageCount: number;
  tokenCount: number;
  status: SessionStatus;
  /** #527 — Sub-state for halted sessions; null when the halt has no
   *  resolution path (manual halt) or the resolution has been consumed
   *  + the session is back to `status: 'active'`. */
  resolutionStatus?: ResolutionStatus | null;
  resolutionOptions?: ResolutionOption[] | null;
  resolutionRecord?: ResolutionRecord | null;
  resolutionDeadlineMs?: number | null;
}

export interface RecordTurnResult {
  allowed: boolean;
  reason?: HaltReason;
  info: SessionInfo;
}

export interface SessionManagerOptions {
  turnLimit?: number;
  tokenLimit?: number;
  /** #529 — Optional runtime-resolved token cap, typically wired to
   *  `PolicyEngine.getSessionLimits().tokenLimit`. Invoked per
   *  `recordTurn` so a `policy.yaml` reload takes effect mid-session
   *  without rebuilding the SessionManager. When set, wins over the
   *  static `tokenLimit` option. */
  tokenLimitProvider?: () => number;
  bus?: EventBus<ForemanEventMap>;
  /** #527 — How long the user has to pick a resolution before the
   *  session auto-abandons. Default 10 min. */
  resolutionTimeoutMs?: number;
  /** #527 — Control channel used to deliver the user's resolution back
   *  to the agents as a `write` directive. When omitted, resume() still
   *  flips state + emits events but no write rows land — useful for
   *  unit tests that exercise the state machine in isolation. */
  controlChannel?: ControlChannel;
  /** #527 — Injectable clock for deterministic resolution-deadline tests. */
  nowFn?: () => number;
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
  private readonly tokenLimitProvider?: () => number;
  private readonly resolutionTimeoutMs: number;
  private readonly controlChannel?: ControlChannel;
  private readonly now: () => number;

  constructor(
    private readonly db: ForemanDb,
    opts: SessionManagerOptions = {},
  ) {
    this.bus = opts.bus ?? defaultBus;
    this.turnLimit = opts.turnLimit ?? DEFAULT_TURN_LIMIT;
    this.tokenLimit = opts.tokenLimit ?? DEFAULT_TOKEN_LIMIT;
    this.tokenLimitProvider = opts.tokenLimitProvider;
    this.resolutionTimeoutMs =
      opts.resolutionTimeoutMs ?? DEFAULT_RESOLUTION_TIMEOUT_MS;
    this.controlChannel = opts.controlChannel;
    this.now = opts.nowFn ?? Date.now;
  }

  // #529 — Resolve the active token cap per enforcement check. Provider
  // wins so policy.yaml reloads land mid-session; defensive fallback to
  // the static option / hardcoded default if the provider throws or
  // returns a non-positive value.
  private resolveTokenLimit(): number {
    if (!this.tokenLimitProvider) return this.tokenLimit;
    try {
      const limit = this.tokenLimitProvider();
      if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
        return limit;
      }
    } catch {
      // ignore — defensive against a misconfigured provider
    }
    return this.tokenLimit;
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
    const overTokens = nextTokens > this.resolveTokenLimit();
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
    const haltedAt = this.now();
    const current = this.get(sessionId);
    // #527 — If the halt reason has a resolution template, surface the
    // "needed" sub-state + emit session:resolution-needed so the
    // notification bridge can dispatch the option buttons. The halt
    // itself stays a halt; provideResolution() later flips state back
    // to active if the user picks a non-abandon path.
    const template = templateForHaltReason(reason);
    const wantsResolution = template.interactive && template.options.length > 0;
    const resolutionDeadlineMs = wantsResolution
      ? haltedAt + this.resolutionTimeoutMs
      : null;
    this.db
      .update(sessions)
      .set({
        status: "halted",
        endedAt: haltedAt,
        resolutionStatus: wantsResolution ? "needed" : null,
        resolutionOptions: wantsResolution
          ? JSON.stringify(template.options)
          : null,
        resolutionPayload: null,
        resolutionDeadlineMs,
      })
      .where(eq(sessions.id, sessionId))
      .run();
    this.bus.emit("session:halted", {
      sessionId,
      reason,
      turnCount,
      tokenCount,
      haltedAt,
    });
    if (wantsResolution && current) {
      this.bus.emit("session:resolution-needed", {
        sessionId,
        reason: reason as "loop_detection" | "turn_limit" | "token_limit" | "manual",
        contextSummary: fallbackContextSummary(reason, current.participants),
        options: template.options,
        deadlineMs: resolutionDeadlineMs!,
        requestedAt: haltedAt,
      });
    }
    // #523 — Halt also completes the session from the user's POV ONLY
    // when the halt isn't waiting for a resolution. If the user might
    // resume, emitting session:completed now would mis-fire the
    // lifecycle push ("⚠ halted") before they had a chance to decide.
    // The resume / expire / abandon paths emit session:completed when
    // the halt truly terminates.
    if (current && !wantsResolution) {
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

  // ============================================================================
  // #527 — Interactive session resume
  // ============================================================================

  /** Mark a user-resolution choice on a halted session. Persists the
   *  pick + emits `session:resumed`, then either flips the session
   *  back to `active` (skip / delegate-to / user-input-needed) or
   *  finalizes it as `completed{outcome: 'abandoned'}` (abandon).
   *
   *  Returns the chosen ResolutionOption when the call succeeds, or
   *  null when the option id is unknown / the session isn't waiting
   *  for a resolution. Bridge surfaces both as user-facing errors. */
  provideResolution(
    sessionId: string,
    optionId: string,
    opts: { providedBy?: string } = {},
  ): ResolutionOption | null {
    const current = this.get(sessionId);
    if (!current) return null;
    if (current.resolutionStatus !== "needed") return null;
    const template = templateForHaltReason(this.lastHaltReason(current));
    const option = findOption(template, optionId);
    if (!option) return null;
    const providedAt = this.now();
    const record: ResolutionRecord = {
      optionId: option.id,
      payload: option.payload,
      providedAt,
      ...(opts.providedBy ? { providedBy: opts.providedBy } : {}),
    };
    this.db
      .update(sessions)
      .set({
        resolutionStatus: "provided",
        resolutionPayload: JSON.stringify(record),
      })
      .where(eq(sessions.id, sessionId))
      .run();
    this.bus.emit("session:resumed", {
      sessionId,
      optionId: option.id,
      payload: option.payload,
      ...(opts.providedBy ? { providedBy: opts.providedBy } : {}),
      resumedAt: providedAt,
    });
    // Dispatch — either resume the session or finalize as abandoned.
    if (option.payload.kind === "abandon") {
      this.finalizeAbandoned(sessionId, "user-abandoned");
    } else {
      this.consumeResolution(sessionId, option.payload, current.participants);
    }
    return option;
  }

  /** Mark a resolution as consumed: deliver the user's directive to the
   *  agents via the control channel (best-effort), flip status back to
   *  `active`, clear the resolution deadline. The session resumes its
   *  normal lifecycle from here — the agents' next tool call is allowed
   *  again. */
  private consumeResolution(
    sessionId: string,
    payload: SessionResolutionPayload,
    participants: string[],
  ): void {
    this.dispatchResolutionToAgents(sessionId, payload, participants);
    this.db
      .update(sessions)
      .set({
        status: "active",
        endedAt: null,
        resolutionStatus: "consumed",
      })
      .where(eq(sessions.id, sessionId))
      .run();
  }

  /** Translate the resolution payload into one or more `write` rows on
   *  the control channel so the drain handler in `foreman start` can
   *  deliver them to the agents. When no channel is wired (unit tests),
   *  the state still flips to `active` — the dispatch step is a no-op
   *  and a follow-up wiring PR can replay missed deliveries from the
   *  audit row. */
  private dispatchResolutionToAgents(
    sessionId: string,
    payload: SessionResolutionPayload,
    participants: string[],
  ): void {
    if (!this.controlChannel) return;
    const sourceAgent = "foreman:session-resume";
    if (payload.kind === "skip") {
      // Broadcast — every participant sees the directive so neither side
      // of a loop assumes the other still wants to argue the point.
      for (const target of participants) {
        this.controlChannel.enqueue({
          command: "write",
          args: [target, `[session ${sessionId}] ${payload.note}`],
          sourceAgent,
        });
      }
      return;
    }
    if (payload.kind === "delegate-to") {
      this.controlChannel.enqueue({
        command: "write",
        args: [
          payload.target,
          `[session ${sessionId}] ${payload.note ?? "user delegated the decision to you"}`,
        ],
        sourceAgent,
      });
      return;
    }
    if (payload.kind === "user-input-needed") {
      // Echo the prompt back to the chat owner via a chat-primary
      // agent. The drain handler routes "write" rows to whichever
      // agent the user is currently chatting with — for v0.1.1 that
      // means the first participant.
      const target = participants[0]
      if (!target) return
      this.controlChannel.enqueue({
        command: "write",
        args: [
          target,
          `[session ${sessionId}] User asked to decide manually: ${payload.prompt}`,
        ],
        sourceAgent,
      });
      return;
    }
    // 'abandon' handled by finalizeAbandoned — no dispatch.
  }

  /** Auto-abandon a halted session whose resolution deadline elapsed.
   *  Called by the bridge / a scheduler when `Date.now() >=
   *  resolutionDeadlineMs` AND `resolutionStatus === 'needed'`. */
  expireResolution(sessionId: string): boolean {
    const current = this.get(sessionId);
    if (!current) return false;
    if (current.resolutionStatus !== "needed") return false;
    this.db
      .update(sessions)
      .set({ resolutionStatus: "expired" })
      .where(eq(sessions.id, sessionId))
      .run();
    this.finalizeAbandoned(sessionId, "resolution_timeout");
    return true;
  }

  private finalizeAbandoned(sessionId: string, reason: string): void {
    const current = this.get(sessionId);
    if (!current) return;
    const completedAt = this.now();
    this.db
      .update(sessions)
      .set({ status: "completed", endedAt: completedAt })
      .where(eq(sessions.id, sessionId))
      .run();
    this.bus.emit("session:completed", {
      sessionId,
      outcome: "abandoned",
      reason,
      turnCount: current.messageCount,
      tokenCount: current.tokenCount,
      costUsd: 0,
      durationMs: completedAt - current.startedAt,
      completedAt,
    });
  }

  /** Best-effort recovery of the halt reason from current state. The
   *  resolution template lookup needs it; for v0.1.1 only loop_detection
   *  is interactively resolvable so we infer based on resolutionOptions
   *  shape (more rigorous: persist `halt_reason` separately, but the
   *  template look-by-option is correct here). */
  private lastHaltReason(info: SessionInfo): HaltReason {
    // The template stamp is implicit in resolutionOptions; we look for
    // an option id unique to the loop template. If none match, fall
    // back to manual (which produces NO_RESOLUTION → findOption=null
    // → caller gets a null result and surfaces an error).
    const ids = (info.resolutionOptions ?? []).map((o) => o.id);
    if (ids.includes("opt-skip") || ids.includes("opt-delegate-pm")) {
      return "loop_detection";
    }
    if (ids.includes("opt-abandon") && ids.length === 1) {
      return "turn_limit"; // budget halts share the same one-option set
    }
    return "manual";
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
      resolutionStatus: row.resolutionStatus ?? null,
      resolutionOptions: safeParseOptions(row.resolutionOptions),
      resolutionRecord: safeParseRecord(row.resolutionPayload),
      resolutionDeadlineMs: row.resolutionDeadlineMs ?? null,
    };
  }
}

function safeParseOptions(text: string | null): ResolutionOption[] | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as ResolutionOption[];
  } catch {
    return null;
  }
}

function safeParseRecord(text: string | null): ResolutionRecord | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as ResolutionRecord;
  } catch {
    return null;
  }
}
