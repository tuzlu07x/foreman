import { and, asc, desc, eq } from "drizzle-orm";
import type { ForemanDb } from "../db/client.js";
import {
  controlCommands,
  type ControlCommand,
} from "../db/schema.js";

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

export class ControlChannel {
  constructor(private readonly db: ForemanDb) {}

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
        createdAt: now,
      })
      .returning({ id: controlCommands.id })
      .all();
    const id = inserted[0]?.id ?? 0;
    return { id, createdAt: now };
  }

  /** Fetch up to N pending rows in FIFO order. Caller is responsible
   *  for marking each one applied / failed after processing. */
  pending(limit = 16): ControlCommand[] {
    return this.db
      .select()
      .from(controlCommands)
      .where(eq(controlCommands.status, "pending"))
      .orderBy(asc(controlCommands.createdAt))
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

  /** Process every pending row using the provided handler map. Marks
   *  the row applied / failed / rejected based on the handler outcome.
   *  Unknown commands are rejected. Returns the count of processed
   *  rows for the caller's logging. */
  async drainPending(
    handlers: Map<string, ControlHandler>,
    limit = 16,
  ): Promise<number> {
    const rows = this.pending(limit);
    for (const row of rows) {
      const handler = handlers.get(row.command);
      if (!handler) {
        this.markRejected(
          row.id,
          `Unknown control command "${row.command}". Update foreman start to register a handler.`,
        );
        continue;
      }
      try {
        const outcome = await handler(row);
        if (outcome.status === "applied") this.markApplied(row.id);
        else if (outcome.status === "failed") this.markFailed(row.id, outcome.error);
        else this.markRejected(row.id, outcome.error);
      } catch (err) {
        this.markFailed(
          row.id,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return rows.length;
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
}

export class ControlDrainPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs: number;

  constructor(
    private readonly channel: ControlChannel,
    private readonly handlers: Map<string, ControlHandler>,
    opts: ControlDrainPollerOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 1500;
  }

  start(): void {
    if (this.timer) return;
    const tick = async (): Promise<void> => {
      if (this.running) return; // avoid overlapping ticks
      this.running = true;
      try {
        await this.channel.drainPending(this.handlers);
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => {
      void tick();
    }, this.intervalMs);
    // Don't keep the event loop alive solely on the poller — foreman
    // start has its own keepAlive interval.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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
