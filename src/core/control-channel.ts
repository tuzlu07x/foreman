import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { ForemanDb } from "../db/client.js";
import {
  controlCommands,
  type ControlCommand,
} from "../db/schema.js";
import type { EventBus, ForemanEventMap } from "./event-bus.js";

// =============================================================================
// Cross-process control channel (#440)
// =============================================================================
//
// `foreman mcp-stdio` is a separate process from `foreman start`. The
// state-mutating /foreman verbs (stop, llm switch, llm budget, write)
// can't be served from mcp-stdio alone — they need to reach the start
// process, which owns the daemon manager + the in-memory LlmConfig.
//
// This service is both ends of that channel:
//   - **Writer side** (mcp-stdio): `enqueue(command)` inserts a row
//     with status="pending" and returns the row id.
//   - **Reader side** (foreman start): `drainPending(handlers)` polls
//     for pending rows, dispatches each through the matching handler,
//     and marks the row applied / failed / rejected.
//
// Polling cadence is decided by the caller (start.ts uses 1500ms). No
// notifications — SQLite doesn't have triggers we can subscribe to
// cheaply across processes. The 1-2s latency is fine for the targeted
// verbs.

export type ControlCommandStatus =
  | "pending"
  | "applied"
  | "failed"
  | "rejected";

export interface EnqueueInput {
  command: string;
  args: string[];
  sourceAgent: string;
  sourceUser?: string | undefined;
  /** Control rows that must finish before this one starts. */
  after?: readonly number[];
}

export interface EnqueueResult {
  id: number;
  createdAt: number;
}

export type ControlHandlerOutcome =
  | { status: "applied" }
  | { status: "failed"; error: string }
  | { status: "rejected"; error: string };

export type ControlHandler = (
  row: ControlCommand,
) => Promise<ControlHandlerOutcome> | ControlHandlerOutcome;

export interface PumpOptions {
  /** Tasks running at once. */
  maxTasks?: number;
  /** A run ended with an error nothing else could report. */
  onError?: (err: unknown) => void;
}

/** Team tasks at once, unless FOREMAN_MAX_PARALLEL_TASKS says otherwise. */
export const DEFAULT_MAX_PARALLEL_TASKS = 4;
/** How far down the queue `pump` looks for something it can start. */
const PUMP_WINDOW = 64;

/** FOREMAN_MAX_PARALLEL_TASKS, or the default. 1 runs tasks one at a time. */
export function maxParallelTasks(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.FOREMAN_MAX_PARALLEL_TASKS);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_PARALLEL_TASKS;
}

/** The agent a task is for: its tasks run in order, others alongside. Null
 *  for a command that isn't a task. */
function taskLane(row: ControlCommand): string | null {
  if (row.command !== "write") return null;
  try {
    const [agent] = JSON.parse(row.args) as unknown[];
    return typeof agent === "string" ? agent.toLowerCase() : "";
  } catch {
    return "";
  }
}

function parseAfterIds(value: string | null): number[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}

export class ControlChannel {
  /** Commands that ran but whose status write failed, by row id. */
  private readonly unrecorded = new Map<
    number,
    { row: ControlCommand; outcome: ControlHandlerOutcome; durationMs: number }
  >();
  /** What `pump` started and hasn't finished. */
  private readonly running = new Map<number, { lane: string | null; done: Promise<void> }>();

  // #498 — Optional bus injection so the writer side (mcp-stdio /
  // foreman write CLI) can announce enqueue events for the TUI. Reader
  // side (foreman start) also keeps a reference so drain outcomes
  // surface as control:applied / control:failed events.
  constructor(
    private readonly db: ForemanDb,
    private readonly bus?: EventBus<ForemanEventMap>,
  ) {}

  /** Queue a state-mutating command for `foreman start` to pick up.
   *  Returns the row id so the caller can include it in the audit log
   *  + the user-facing reply (e.g. "queued; id=42"). */
  enqueue(input: EnqueueInput): EnqueueResult {
    const now = Date.now();
    const inserted = this.db
      .insert(controlCommands)
      .values({
        command: input.command,
        args: JSON.stringify(input.args),
        sourceAgent: input.sourceAgent,
        sourceUser: input.sourceUser ?? null,
        status: "pending",
        afterIds: input.after && input.after.length > 0 ? JSON.stringify(input.after) : null,
        createdAt: now,
      })
      .returning({ id: controlCommands.id })
      .all();
    const id = inserted[0]?.id ?? 0;
    this.bus?.emit("control:enqueued", {
      id,
      command: input.command,
      args: input.args,
      sourceAgent: input.sourceAgent,
      sourceUser: input.sourceUser,
      createdAt: now,
    });
    return { id, createdAt: now };
  }

  /** Fetch up to N pending rows in FIFO order. Caller is responsible
   *  for marking each one applied / failed after processing. */
  pending(limit = 16): ControlCommand[] {
    return this.db
      .select()
      .from(controlCommands)
      .where(eq(controlCommands.status, "pending"))
      .orderBy(asc(controlCommands.createdAt), asc(controlCommands.id))
      .limit(limit)
      .all();
  }

  markApplied(id: number): void {
    this.db
      .update(controlCommands)
      .set({ status: "applied", appliedAt: Date.now(), error: null })
      .where(eq(controlCommands.id, id))
      .run();
  }

  markFailed(id: number, error: string): void {
    this.db
      .update(controlCommands)
      .set({ status: "failed", appliedAt: Date.now(), error })
      .where(eq(controlCommands.id, id))
      .run();
  }

  markRejected(id: number, error: string): void {
    this.db
      .update(controlCommands)
      .set({ status: "rejected", appliedAt: Date.now(), error })
      .where(eq(controlCommands.id, id))
      .run();
  }

  /** Most-recent rows first — backs `/foreman activity` so users can
   *  see what directives have been issued and their status without
   *  needing the Foreman LLM. */
  recent(limit = 10): ControlCommand[] {
    return this.db
      .select()
      .from(controlCommands)
      // Tiebreak by id desc — rows enqueued in the same millisecond
      // otherwise come back in undefined order, which makes the
      // newest-first contract user-visibly flaky.
      .orderBy(desc(controlCommands.createdAt), desc(controlCommands.id))
      .limit(limit)
      .all();
  }

  /** Get a single row by id — used by tests + the synchronous drain
   *  inspection path. Returns null when the row doesn't exist. */
  get(id: number): ControlCommand | null {
    const rows = this.db
      .select()
      .from(controlCommands)
      .where(eq(controlCommands.id, id))
      .limit(1)
      .all();
    return rows[0] ?? null;
  }

  /** Start what can start now and return, without waiting for it: the
   *  gateway's loop. Tasks for different agents run side by side, up to
   *  `maxTasks`; one agent's tasks stay in order; a task with `after` waits
   *  for those rows; a command that isn't a task (`stop`, `llm-switch`…)
   *  waits for nothing. Returns how many it started. */
  pump(handlers: Map<string, ControlHandler>, opts: PumpOptions = {}): number {
    const maxTasks = opts.maxTasks ?? DEFAULT_MAX_PARALLEL_TASKS;
    this.flushUnrecorded();
    const lanes = new Set<string>();
    let tasks = 0;
    for (const { lane } of this.running.values()) {
      if (lane === null) continue;
      lanes.add(lane);
      tasks++;
    }
    let started = 0;
    for (const row of this.pending(PUMP_WINDOW)) {
      if (this.running.has(row.id)) continue;
      const lane = taskLane(row);
      if (lane !== null) {
        const taken = lanes.has(lane);
        // A later task for this agent stays behind this one, started or not.
        lanes.add(lane);
        if (taken) continue;
        const after = this.afterState(row);
        if (after === "waiting") continue;
        if (after !== "ready") {
          this.record(row, { status: "rejected", error: after.error }, 0);
          continue;
        }
        if (tasks >= maxTasks) continue;
        tasks++;
      }
      const done = this.runRow(row, handlers)
        .catch((err: unknown) => opts.onError?.(err))
        .finally(() => this.running.delete(row.id));
      this.running.set(row.id, { lane, done });
      started++;
    }
    return started;
  }

  /** Resolves when everything `pump` started has finished. */
  async settled(): Promise<void> {
    await Promise.all([...this.running.values()].map((r) => r.done));
  }

  /** Whether the rows `row` waits for are done. One that failed means the
   *  work it was to build on isn't there, so this one must not start. */
  private afterState(row: ControlCommand): "ready" | "waiting" | { error: string } {
    const ids = parseAfterIds(row.afterIds);
    if (ids.length === 0) return "ready";
    const rows = this.db.select().from(controlCommands).where(inArray(controlCommands.id, ids)).all();
    if (rows.some((r) => r.status === "pending")) return "waiting";
    const failed = rows.find((r) => r.status !== "applied");
    if (!failed) return "ready";
    return { error: `Not started: it was waiting for ${taskLane(failed) ?? `#${failed.id}`}, which didn't finish.` };
  }

  /** Process every pending row using the provided handler map. Marks
   *  the row applied / failed / rejected based on the handler outcome.
   *  Unknown commands are rejected. Returns the count of processed
   *  rows for the caller's logging. */
  async drainPending(
    handlers: Map<string, ControlHandler>,
    limit = 16,
  ): Promise<number> {
    this.flushUnrecorded();
    const rows = this.pending(limit);
    for (const row of rows) await this.runRow(row, handlers);
    return rows.length;
  }

  /** Outcomes a previous drain could not write (#594): record them first.
   *  Their rows still read "pending", but the command already ran and must
   *  not run again (a delegated agent would be spawned twice). */
  private flushUnrecorded(): void {
    for (const [id, done] of this.unrecorded) {
      this.record(done.row, done.outcome, done.durationMs);
      this.unrecorded.delete(id);
    }
  }

  private async runRow(row: ControlCommand, handlers: Map<string, ControlHandler>): Promise<void> {
    const handler = handlers.get(row.command);
    const startedAt = Date.now();
    let outcome: ControlHandlerOutcome;
    if (!handler) {
      outcome = {
        status: "rejected",
        error: `Unknown control command "${row.command}". Update foreman start to register a handler.`,
      };
    } else {
      try {
        outcome = await handler(row);
      } catch (err) {
        outcome = {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    const durationMs = Date.now() - startedAt;
    try {
      this.record(row, outcome, durationMs);
    } catch (err) {
      // The command ran; only its status write failed (e.g. another
      // process held the database past its busy timeout). Keep the
      // outcome for the next drain instead of recording a false
      // "failed" or running the command again.
      this.unrecorded.set(row.id, { row, outcome, durationMs });
      throw err;
    }
  }

  private record(
    row: ControlCommand,
    outcome: ControlHandlerOutcome,
    durationMs: number,
  ): void {
    if (outcome.status === "applied") {
      this.markApplied(row.id);
      this.emitApplied(row, durationMs);
    } else if (outcome.status === "failed") {
      this.markFailed(row.id, outcome.error);
      this.emitFailed(row, "failed", outcome.error);
    } else {
      this.markRejected(row.id, outcome.error);
      this.emitFailed(row, "rejected", outcome.error);
    }
  }

  private emitApplied(row: ControlCommand, durationMs: number): void {
    if (!this.bus) return;
    this.bus.emit("control:applied", {
      id: row.id,
      command: row.command,
      sourceAgent: row.sourceAgent,
      durationMs,
      appliedAt: Date.now(),
    });
  }

  private emitFailed(
    row: ControlCommand,
    status: "failed" | "rejected",
    error: string,
  ): void {
    if (!this.bus) return;
    this.bus.emit("control:failed", {
      id: row.id,
      command: row.command,
      sourceAgent: row.sourceAgent,
      status,
      error,
      failedAt: Date.now(),
    });
  }
}

// =============================================================================
// Poller — wires the drain loop to a periodic timer.
// =============================================================================
//
// Separated from ControlChannel so tests can exercise drainPending
// without dealing with timers. `foreman start` instantiates this once.

export interface ControlDrainPollerOptions {
  intervalMs?: number;
  /** Tasks running at once (see maxParallelTasks). */
  maxTasks?: number;
  /** Told when a drain fails (e.g. another process held the database past
   *  its busy timeout); the next tick tries again. Defaults to stderr. */
  onError?: (message: string) => void;
}

export class ControlDrainPoller {
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly maxTasks: number | undefined;
  private readonly onError: (message: string) => void;

  constructor(
    private readonly channel: ControlChannel,
    private readonly handlers: Map<string, ControlHandler>,
    opts: ControlDrainPollerOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 1500;
    this.maxTasks = opts.maxTasks;
    this.onError =
      opts.onError ??
      ((message) => process.stderr.write(`foreman: ${message}\n`));
  }

  start(): void {
    if (this.timer) return;
    // Unhandled, a rejection here took `foreman start` down (#594).
    const failed = (err: unknown): void =>
      this.onError(
        `control channel drain failed, retrying on the next tick: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    this.timer = setInterval(() => {
      try {
        this.channel.pump(this.handlers, {
          ...(this.maxTasks !== undefined ? { maxTasks: this.maxTasks } : {}),
          onError: failed,
        });
      } catch (err) {
        failed(err);
      }
    }, this.intervalMs);
    // Don't keep the event loop alive solely on the poller — foreman
    // start has its own keepAlive interval.
    this.timer.unref?.();
  }

  /** Stop polling and wait for the commands already running, so the
   *  database isn't closed underneath them on shutdown. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.channel.settled().catch(() => undefined);
  }
}

// =============================================================================
// Owner gating helper
// =============================================================================
//
// All mutating /foreman commands check that the messaging-platform
// user id matches Foreman's recorded owner. For Telegram that's the
// `telegram-chat-id` secret (#427 already requires this for OpenClaw's
// allowFrom). When the secret is missing or the user id doesn't match,
// the verb is rejected with NOT_AUTHORIZED.

export interface OwnerCheckInput {
  sourceUser?: string | undefined;
}

export interface OwnerStore {
  /** Returns the configured owner user id (Telegram chat id) or null
   *  when no owner is set up. */
  get(name: string): string;
  exists(name: string): boolean;
}

export function isOwner(store: OwnerStore, input: OwnerCheckInput): boolean {
  if (!input.sourceUser) return false;
  if (!store.exists("telegram-chat-id")) return false;
  try {
    return store.get("telegram-chat-id") === input.sourceUser;
  } catch {
    return false;
  }
}
