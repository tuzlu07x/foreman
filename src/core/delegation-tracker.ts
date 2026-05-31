/**
 * Delegation tracker — autonomous loop enforcement, PR A of the multi-agent
 * UX epic.
 *
 * Foreman watches every `foreman write <peer> <task>` directive and tracks
 * whether the initiating agent followed up on the peer's output. Three
 * roles:
 *
 *   1. **Recorder** — `recordDelegation` / `recordOutputReceived` /
 *      `recordFollowUp` write the lifecycle rows.
 *
 *   2. **Watchdog** — `pendingNudges(threshold)` returns delegations
 *      whose output arrived but the initiator has been idle for
 *      longer than `threshold`. The drain loop in `foreman start`
 *      calls this every ~15s.
 *
 *   3. **Dispatcher** — `recordNudge` / `recordEscalation` advance the
 *      lifecycle state when a nudge fires.
 *
 * The module is intentionally pure (no IO, no clock from a global —
 * `Date.now()` injection via `nowMs` so tests are deterministic). The
 * actual nudge message + Telegram push lives in `start.ts` so this
 * module doesn't pull in the channel layer.
 */

import { and, asc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { ulid } from "ulid";

import type { ForemanDb } from "../db/client.js";
import {
  delegations,
  type Delegation,
  type NewDelegation,
} from "../db/schema.js";

// =============================================================================
// Configuration constants
// =============================================================================

/** Default watchdog threshold — how long to wait after output arrived
 *  before the first nudge. 30 seconds matches a "reasonable LLM
 *  reaction time" without being annoying when the agent is genuinely
 *  thinking. */
export const DEFAULT_NUDGE_THRESHOLD_MS = 30_000;

/** Default cap on nudges per delegation. After this many nudges
 *  without an initiator follow-up, the delegation is escalated to
 *  the user (out-of-band signal that the agent is stuck). */
export const DEFAULT_MAX_NUDGES = 3;

/** Default minimum gap between consecutive nudges on the same
 *  delegation — prevents tight nudge-storms when the watchdog
 *  fires faster than the initiator can react. */
export const DEFAULT_NUDGE_COOLDOWN_MS = 30_000;

/** Default runaway-loop guard window: how recent the suspicious
 *  delegations have to be to count. 10 minutes captures the kind
 *  of LLM-driven retry storm we want to catch without flagging
 *  legitimate sequential work over a longer day. */
export const DEFAULT_RUNAWAY_WINDOW_MS = 10 * 60_000;

/** Default runaway-loop trigger: more than this many active (not
 *  successfully closed) delegations from one initiator to one
 *  target inside the runaway window → hard stop + escalation. */
export const DEFAULT_RUNAWAY_MAX_ACTIVE = 5;

/** How long the prompt summary can be before truncation. Keep short
 *  so the nudge text isn't an essay. */
const PROMPT_SUMMARY_MAX = 200;

// =============================================================================
// Types
// =============================================================================

export interface RecordDelegationInput {
  /** The agent that issued the `foreman write` directive. */
  initiatorAgent: string;
  /** The agent receiving the directive. */
  targetAgent: string;
  /** Full prompt body — gets truncated to PROMPT_SUMMARY_MAX so the
   *  nudge text stays scannable. */
  prompt: string;
  /** Optional pointer to the control_commands row carrying this
   *  directive — lets the audit log + the watchdog correlate
   *  nudges with the underlying queue entry. */
  controlCommandId?: number | null;
}

export interface RecordOutputInput {
  delegationId: string;
  /** Spawn outcome kind ("ok" / "failed" / "timeout" / "spawn-error" /
   *  "unsupported"). Stored so the nudge message can reflect the
   *  actual situation: "codex finished" vs "codex failed (exit 1) —
   *  handle this". */
  spawnOutcome?: string;
}

export interface DelegationTrackerOptions {
  db: ForemanDb;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  nowMs?: () => number;
  /** Threshold (ms) — watchdog returns delegations whose output is
   *  older than this. Default 30000. */
  nudgeThresholdMs?: number;
  /** Maximum nudges before escalation. Default 3. */
  maxNudges?: number;
  /** Minimum gap (ms) between two nudges on the same delegation.
   *  Default 30000. */
  nudgeCooldownMs?: number;
  /** Runaway-loop guard window (ms). Default 600000 (10 minutes). */
  runawayWindowMs?: number;
  /** Max number of active (not successfully closed) delegations
   *  from one initiator to one target inside the runaway window
   *  before the guard fires. Default 5. */
  runawayMaxActive?: number;
}

/** Result of a runaway-loop check. `ok` means the new delegation is
 *  safe to record; `blocked` means the writeHandler should reject the
 *  directive with the supplied reason. */
export type RunawayCheckResult =
  | { ok: true }
  | { ok: false; reason: string; activeCount: number };

// =============================================================================
// Service
// =============================================================================

export class DelegationTracker {
  private readonly db: ForemanDb;
  private readonly nowMs: () => number;
  readonly nudgeThresholdMs: number;
  readonly maxNudges: number;
  readonly nudgeCooldownMs: number;
  readonly runawayWindowMs: number;
  readonly runawayMaxActive: number;

  constructor(opts: DelegationTrackerOptions) {
    this.db = opts.db;
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.nudgeThresholdMs =
      opts.nudgeThresholdMs ?? DEFAULT_NUDGE_THRESHOLD_MS;
    this.maxNudges = opts.maxNudges ?? DEFAULT_MAX_NUDGES;
    this.nudgeCooldownMs = opts.nudgeCooldownMs ?? DEFAULT_NUDGE_COOLDOWN_MS;
    this.runawayWindowMs =
      opts.runawayWindowMs ?? DEFAULT_RUNAWAY_WINDOW_MS;
    this.runawayMaxActive =
      opts.runawayMaxActive ?? DEFAULT_RUNAWAY_MAX_ACTIVE;
  }

  /**
   * Runaway-loop guard. Counts the active (not successfully closed)
   * delegations from `initiator` to `target` started inside the
   * runaway window. If the count is at or above the trigger, return
   * a blocked result with an explanatory reason for the writeHandler
   * to surface. Calling this BEFORE recordDelegation so the bad
   * directive never makes it into the queue.
   *
   * "Active" = status NOT in ('closed', 'abandoned'). 'escalated'
   * counts as active because nothing has resolved — the escalated
   * row is precisely the kind of unresolved chain we're trying to
   * prevent from snowballing.
   */
  checkRunawayLoop(
    initiator: string,
    target: string,
  ): RunawayCheckResult {
    const now = this.nowMs();
    const cutoff = now - this.runawayWindowMs;
    const rows = this.db
      .select()
      .from(delegations)
      .where(
        and(
          eq(delegations.initiatorAgent, initiator.toLowerCase()),
          eq(delegations.targetAgent, target.toLowerCase()),
        ),
      )
      .all();
    const active = rows.filter(
      (r) =>
        r.startedAt >= cutoff &&
        r.status !== "closed" &&
        r.status !== "abandoned",
    );
    if (active.length >= this.runawayMaxActive) {
      const minutes = Math.round(this.runawayWindowMs / 60_000);
      return {
        ok: false,
        activeCount: active.length,
        reason:
          `Runaway-loop guard blocked: ${initiator} has ${active.length} ` +
          `unresolved delegations to ${target} in the last ${minutes} ` +
          `minutes (max ${this.runawayMaxActive}). The chain looks stuck — ` +
          `pause and ask the user before re-delegating to the same target.`,
      };
    }
    return { ok: true };
  }

  /**
   * Record a fresh delegation. Returns the generated id (ULID) so
   * callers can chain `recordOutputReceived` and `recordFollowUp`
   * against it.
   *
   * The `initiatorAgent` may be the same as `targetAgent` in some
   * edge cases (self-target) — we still record it; the writeHandler
   * upstream already blocks the obvious self-write loop.
   */
  recordDelegation(input: RecordDelegationInput): string {
    const id = ulid();
    const summary = truncatePrompt(input.prompt);
    const row: NewDelegation = {
      id,
      initiatorAgent: input.initiatorAgent.toLowerCase(),
      targetAgent: input.targetAgent.toLowerCase(),
      promptSummary: summary,
      controlCommandId: input.controlCommandId ?? null,
      startedAt: this.nowMs(),
      status: "open",
    };
    this.db.insert(delegations).values(row).run();
    return id;
  }

  /**
   * Mark a delegation as having received the peer's output. Flips
   * status open → awaiting so the watchdog starts considering it.
   * Idempotent — re-calling with the same id is a no-op (we don't
   * re-flip status if it's already past 'awaiting').
   */
  recordOutputReceived(input: RecordOutputInput): void {
    const row = this.find(input.delegationId);
    if (!row) return;
    if (row.outputReceivedAt !== null) return; // idempotent
    this.db
      .update(delegations)
      .set({
        outputReceivedAt: this.nowMs(),
        spawnOutcome: input.spawnOutcome ?? null,
        status: row.status === "open" ? "awaiting" : row.status,
      })
      .where(eq(delegations.id, input.delegationId))
      .run();
  }

  /**
   * Mark a delegation as resolved — the initiator did SOMETHING after
   * the output arrived (issued a new `foreman write`, posted a reply,
   * etc). Closes the row.
   *
   * Heuristic upstream: any new `foreman write` from the initiator
   * is treated as follow-up on its OLDEST open delegation. Future
   * versions can refine ("did the new directive reference the
   * earlier task?") but the simple version captures most cases.
   */
  recordFollowUp(delegationId: string): void {
    const row = this.find(delegationId);
    if (!row) return;
    if (row.followUpAt !== null) return; // idempotent
    this.db
      .update(delegations)
      .set({
        followUpAt: this.nowMs(),
        status: "closed",
      })
      .where(eq(delegations.id, delegationId))
      .run();
  }

  /**
   * Close ALL open/awaiting/nudged delegations where this agent is
   * the initiator. Called when the same agent issues another
   * `foreman write` — that's our heuristic for "they're acting on
   * the previous output." Returns the count closed for observability.
   */
  closeOpenInitiatorRows(initiatorAgent: string): number {
    const now = this.nowMs();
    const result = this.db
      .update(delegations)
      .set({ followUpAt: now, status: "closed" })
      .where(
        and(
          eq(delegations.initiatorAgent, initiatorAgent.toLowerCase()),
          isNull(delegations.followUpAt),
          isNotNull(delegations.outputReceivedAt),
        ),
      )
      .run();
    return Number(result?.changes ?? 0);
  }

  /**
   * Return delegations the watchdog should nudge: status in
   * ('awaiting', 'nudged'), output_received_at older than the
   * threshold, last nudge respects cooldown, nudge_count below max.
   *
   * Sorted by output_received_at ASC so the oldest gets nudged
   * first when multiple are due simultaneously.
   */
  pendingNudges(thresholdMs: number = this.nudgeThresholdMs): Delegation[] {
    const now = this.nowMs();
    const outputCutoff = now - thresholdMs;
    const cooldownCutoff = now - this.nudgeCooldownMs;
    const rows = this.db
      .select()
      .from(delegations)
      .where(
        and(
          // Only rows whose output has arrived + initiator hasn't
          // followed up yet. (Drizzle's inArray would also work; two
          // explicit ORs are clearer here.)
          isNull(delegations.followUpAt),
          isNotNull(delegations.outputReceivedAt),
          lt(delegations.outputReceivedAt, outputCutoff),
        ),
      )
      .orderBy(asc(delegations.outputReceivedAt))
      .all();
    return rows.filter((r) => {
      if (r.status !== "awaiting" && r.status !== "nudged") return false;
      if (r.nudgeCount >= this.maxNudges) return false;
      if (r.lastNudgeAt !== null && r.lastNudgeAt > cooldownCutoff) {
        return false;
      }
      return true;
    });
  }

  /**
   * Record that a nudge was sent. Bumps nudge_count, sets
   * last_nudge_at, flips status awaiting → nudged.
   */
  recordNudge(delegationId: string): void {
    const row = this.find(delegationId);
    if (!row) return;
    this.db
      .update(delegations)
      .set({
        nudgeCount: row.nudgeCount + 1,
        lastNudgeAt: this.nowMs(),
        status: "nudged",
      })
      .where(eq(delegations.id, delegationId))
      .run();
  }

  /**
   * Mark a delegation as escalated (max nudges hit). The caller
   * should send a separate "this loop is stuck" message to the
   * user; this method only flips the lifecycle state.
   */
  recordEscalation(delegationId: string): void {
    this.db
      .update(delegations)
      .set({ status: "escalated", lastNudgeAt: this.nowMs() })
      .where(eq(delegations.id, delegationId))
      .run();
  }

  /**
   * Find a delegation by id, or null. Public so the watchdog can
   * inspect rows before deciding on nudge vs escalation.
   */
  find(delegationId: string): Delegation | null {
    return (
      this.db
        .select()
        .from(delegations)
        .where(eq(delegations.id, delegationId))
        .get() ?? null
    );
  }

  /**
   * Return the most recent delegations involving an agent (as either
   * initiator or target). Used by the CLI + TUI to show "what's this
   * agent been up to?".
   */
  recentForAgent(agent: string, limit = 20): Delegation[] {
    const id = agent.toLowerCase();
    // Drizzle ORM doesn't currently have a clean OR helper across
    // multiple columns + sort — fall back to two queries + merge.
    const asInitiator = this.db
      .select()
      .from(delegations)
      .where(eq(delegations.initiatorAgent, id))
      .all();
    const asTarget = this.db
      .select()
      .from(delegations)
      .where(eq(delegations.targetAgent, id))
      .all();
    const seen = new Set<string>();
    const merged: Delegation[] = [];
    for (const row of [...asInitiator, ...asTarget]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
    merged.sort((a, b) => b.startedAt - a.startedAt);
    return merged.slice(0, limit);
  }

  /**
   * Return active delegations across all agents — TUI Active
   * Delegations panel + `foreman delegations list` CLI both read
   * from here. "Active" = status NOT in ('closed', 'abandoned').
   * Ordered most-recent-first so live rows show at the top.
   */
  activeAcrossAgents(limit = 50): Delegation[] {
    // Drizzle's `inArray` would make this cleaner, but the simple
    // filter on the in-memory result is plenty for a watchdog-scale
    // table (rows are never huge in practice — closed delegations
    // age out of the active window quickly).
    const rows = this.db
      .select()
      .from(delegations)
      .orderBy(asc(delegations.startedAt))
      .all();
    const active = rows.filter(
      (r) => r.status !== "closed" && r.status !== "abandoned",
    );
    active.sort((a, b) => b.startedAt - a.startedAt);
    return active.slice(0, limit);
  }

  /**
   * Return the N most recent delegations regardless of status —
   * useful for `foreman delegations list --recent` and audit
   * lookups.
   */
  recent(limit = 50): Delegation[] {
    return this.db
      .select()
      .from(delegations)
      .all()
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }
}

// =============================================================================
// Helpers
// =============================================================================

function truncatePrompt(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= PROMPT_SUMMARY_MAX) return trimmed;
  return trimmed.slice(0, PROMPT_SUMMARY_MAX - 1) + "…";
}

// =============================================================================
// Nudge text builders — pure, exported for tests + the dispatcher.
// =============================================================================

/**
 * Compose the chat message the watchdog pushes to the initiator
 * when a nudge fires. Includes the peer, the prompt summary, and a
 * suggested action ladder so the LLM gets a concrete next step
 * rather than just "do something."
 */
export function composeNudgeText(row: Delegation): string {
  const peerLabel = row.targetAgent;
  const promptLine = row.promptSummary ? `\n_Task:_ ${row.promptSummary}` : "";
  const outcomeLine = row.spawnOutcome
    ? `\n_Outcome:_ ${row.spawnOutcome}`
    : "";
  const numbered =
    row.nudgeCount === 0
      ? "📩"
      : `📩 (nudge ${row.nudgeCount + 1}/${maxNudgeText(row)})`;
  return (
    `${numbered} ${peerLabel}'s output is waiting on your action.${promptLine}${outcomeLine}\n\n` +
    `Per your responsibility, review what ${peerLabel} produced and take the next step ` +
    `(merge / request changes / re-delegate / escalate to user). Don't go idle.`
  );
}

/** Max-nudge text helper that pulls the cap from the row's existing
 *  state when the tracker isn't directly accessible. Defaults to 3
 *  so the message reads sensibly without coupling to the service. */
function maxNudgeText(_row: Delegation): string {
  return String(DEFAULT_MAX_NUDGES);
}

/**
 * Compose the escalation text — pushed to the user (not the
 * initiator) when an LLM agent ignores N nudges in a row. Signals
 * that human intervention is needed.
 */
export function composeEscalationText(row: Delegation): string {
  return (
    `⚠ Multi-agent loop stuck:\n\n` +
    `• Initiator: ${row.initiatorAgent}\n` +
    `• Peer:      ${row.targetAgent}\n` +
    `• Task:      ${row.promptSummary}\n` +
    `• Status:    ${row.targetAgent} finished` +
    (row.spawnOutcome ? ` (${row.spawnOutcome})` : "") +
    `, but ${row.initiatorAgent} hasn't followed up after ${row.nudgeCount} nudges.\n\n` +
    `Action needed: type \`/foreman write ${row.initiatorAgent} <next step>\` to ` +
    `unstick the loop, or "stop" if the chain should halt.`
  );
}
