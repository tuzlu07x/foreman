import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composeEscalationText,
  composeNudgeText,
  DEFAULT_MAX_NUDGES,
  DEFAULT_NUDGE_THRESHOLD_MS,
  DelegationTracker,
} from "../../src/core/delegation-tracker.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";
import { delegations } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

describe("DelegationTracker", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let now: number;
  let tracker: DelegationTracker;

  beforeEach(() => {
    const h = createInMemoryDb();
    db = h.db;
    sqlite = h.sqlite;
    now = 1_700_000_000_000;
    tracker = new DelegationTracker({
      db,
      nowMs: () => now,
      nudgeThresholdMs: 30_000,
      maxNudges: 3,
      nudgeCooldownMs: 30_000,
    });
  });

  afterEach(() => {
    sqlite.close();
  });

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  describe("recordDelegation", () => {
    it("inserts a row + returns the new id", () => {
      const id = tracker.recordDelegation({
        initiatorAgent: "hermes",
        targetAgent: "codex",
        prompt: "build a thing",
      });
      expect(id.length).toBeGreaterThan(0);
      const row = tracker.find(id);
      expect(row).not.toBeNull();
      expect(row!.initiatorAgent).toBe("hermes");
      expect(row!.targetAgent).toBe("codex");
      expect(row!.promptSummary).toBe("build a thing");
      expect(row!.startedAt).toBe(now);
      expect(row!.status).toBe("open");
      expect(row!.nudgeCount).toBe(0);
      expect(row!.outputReceivedAt).toBeNull();
      expect(row!.followUpAt).toBeNull();
    });

    it("truncates long prompts to keep the nudge text scannable", () => {
      const id = tracker.recordDelegation({
        initiatorAgent: "hermes",
        targetAgent: "codex",
        prompt: "a".repeat(500),
      });
      const row = tracker.find(id)!;
      expect(row.promptSummary.length).toBeLessThanOrEqual(200);
      expect(row.promptSummary.endsWith("…")).toBe(true);
    });

    it("lowercases the agent ids so subsequent queries don't miss on case", () => {
      const id = tracker.recordDelegation({
        initiatorAgent: "Hermes",
        targetAgent: "Codex",
        prompt: "x",
      });
      const row = tracker.find(id)!;
      expect(row.initiatorAgent).toBe("hermes");
      expect(row.targetAgent).toBe("codex");
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle transitions
  // -------------------------------------------------------------------------

  describe("recordOutputReceived", () => {
    it("flips open → awaiting + sets timestamp + outcome", () => {
      const id = tracker.recordDelegation({
        initiatorAgent: "hermes",
        targetAgent: "codex",
        prompt: "x",
      });
      now += 5_000;
      tracker.recordOutputReceived({ delegationId: id, spawnOutcome: "ok" });
      const row = tracker.find(id)!;
      expect(row.outputReceivedAt).toBe(now);
      expect(row.spawnOutcome).toBe("ok");
      expect(row.status).toBe("awaiting");
    });

    it("is idempotent — calling twice does not re-stamp the timestamp", () => {
      const id = tracker.recordDelegation({
        initiatorAgent: "hermes",
        targetAgent: "codex",
        prompt: "x",
      });
      now += 5_000;
      tracker.recordOutputReceived({ delegationId: id });
      const firstStamp = tracker.find(id)!.outputReceivedAt;
      now += 5_000;
      tracker.recordOutputReceived({ delegationId: id });
      expect(tracker.find(id)!.outputReceivedAt).toBe(firstStamp);
    });

    it("is a no-op for an unknown delegation id", () => {
      expect(() =>
        tracker.recordOutputReceived({ delegationId: "bogus-id" }),
      ).not.toThrow();
    });
  });

  describe("recordFollowUp", () => {
    it("closes the row + sets timestamp", () => {
      const id = tracker.recordDelegation({
        initiatorAgent: "hermes",
        targetAgent: "codex",
        prompt: "x",
      });
      tracker.recordOutputReceived({ delegationId: id });
      now += 10_000;
      tracker.recordFollowUp(id);
      const row = tracker.find(id)!;
      expect(row.followUpAt).toBe(now);
      expect(row.status).toBe("closed");
    });

    it("is idempotent", () => {
      const id = tracker.recordDelegation({
        initiatorAgent: "hermes",
        targetAgent: "codex",
        prompt: "x",
      });
      tracker.recordOutputReceived({ delegationId: id });
      tracker.recordFollowUp(id);
      const firstStamp = tracker.find(id)!.followUpAt;
      now += 1_000;
      tracker.recordFollowUp(id);
      expect(tracker.find(id)!.followUpAt).toBe(firstStamp);
    });
  });

  describe("closeOpenInitiatorRows — new write closes earlier delegations", () => {
    it("closes only rows whose output has arrived and follow-up is null", () => {
      // Setup: hermes has 3 delegations
      //   #1: output received, no follow-up → SHOULD close
      //   #2: still in flight (open) → should NOT close
      //   #3: already followed up → should stay closed
      const id1 = tracker.recordDelegation({
        initiatorAgent: "hermes",
        targetAgent: "codex",
        prompt: "a",
      });
      const id2 = tracker.recordDelegation({
        initiatorAgent: "hermes",
        targetAgent: "codex",
        prompt: "b",
      });
      const id3 = tracker.recordDelegation({
        initiatorAgent: "hermes",
        targetAgent: "codex",
        prompt: "c",
      });
      tracker.recordOutputReceived({ delegationId: id1 });
      // id2 stays open (no output yet)
      tracker.recordOutputReceived({ delegationId: id3 });
      tracker.recordFollowUp(id3);

      now += 5_000;
      const closed = tracker.closeOpenInitiatorRows("hermes");
      expect(closed).toBe(1); // only id1
      expect(tracker.find(id1)!.status).toBe("closed");
      expect(tracker.find(id1)!.followUpAt).toBe(now);
      expect(tracker.find(id2)!.status).toBe("open"); // untouched
      expect(tracker.find(id3)!.status).toBe("closed"); // already closed
    });

    it("doesn't touch a different initiator's rows", () => {
      const myId = tracker.recordDelegation({
        initiatorAgent: "hermes",
        targetAgent: "codex",
        prompt: "x",
      });
      tracker.recordOutputReceived({ delegationId: myId });
      const otherId = tracker.recordDelegation({
        initiatorAgent: "openclaw",
        targetAgent: "codex",
        prompt: "y",
      });
      tracker.recordOutputReceived({ delegationId: otherId });

      tracker.closeOpenInitiatorRows("hermes");
      expect(tracker.find(myId)!.status).toBe("closed");
      expect(tracker.find(otherId)!.status).toBe("awaiting"); // untouched
    });
  });

  // -------------------------------------------------------------------------
  // Watchdog query
  // -------------------------------------------------------------------------

  describe("pendingNudges", () => {
    it("returns rows whose output is older than the threshold", () => {
      const id = tracker.recordDelegation({
        initiatorAgent: "hermes",
        targetAgent: "codex",
        prompt: "x",
      });
      tracker.recordOutputReceived({ delegationId: id });
      // Just past threshold:
      now += 31_000;
      const pending = tracker.pendingNudges();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.id).toBe(id);
    });

    it("does NOT return rows still within the threshold", () => {
      const id = tracker.recordDelegation({
        initiatorAgent: "hermes",
        targetAgent: "codex",
        prompt: "x",
      });
      tracker.recordOutputReceived({ delegationId: id });
      now += 10_000; // < 30s threshold
      expect(tracker.pendingNudges()).toEqual([]);
    });

    it("does NOT return rows whose output hasn't arrived yet", () => {
      tracker.recordDelegation({
        initiatorAgent: "hermes",
        targetAgent: "codex",
        prompt: "x",
      });
      now += 60_000;
      expect(tracker.pendingNudges()).toEqual([]);
    });

    it("does NOT return rows that have been followed up", () => {
      const id = tracker.recordDelegation({
        initiatorAgent: "hermes",
        targetAgent: "codex",
        prompt: "x",
      });
      tracker.recordOutputReceived({ delegationId: id });
      tracker.recordFollowUp(id);
      now += 60_000;
      expect(tracker.pendingNudges()).toEqual([]);
    });

    it("does NOT return rows that have exhausted their nudges (escalation territory)", () => {
      const id = tracker.recordDelegation({
        initiatorAgent: "hermes",
        targetAgent: "codex",
        prompt: "x",
      });
      tracker.recordOutputReceived({ delegationId: id });
      now += 60_000;
      // Burn through max nudges with cooldown advances
      for (let i = 0; i < 3; i++) {
        tracker.recordNudge(id);
        now += 31_000;
      }
      expect(tracker.find(id)!.nudgeCount).toBe(DEFAULT_MAX_NUDGES);
      expect(tracker.pendingNudges()).toEqual([]);
    });

    it("respects the per-row nudge cooldown", () => {
      const id = tracker.recordDelegation({
        initiatorAgent: "hermes",
        targetAgent: "codex",
        prompt: "x",
      });
      tracker.recordOutputReceived({ delegationId: id });
      now += 31_000;
      tracker.recordNudge(id);
      // Still due past threshold, but cooldown not over yet
      now += 10_000;
      expect(tracker.pendingNudges()).toEqual([]);
      // Past cooldown
      now += 21_000;
      expect(tracker.pendingNudges()).toHaveLength(1);
    });

    it("orders by oldest output_received_at first", () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const id = tracker.recordDelegation({
          initiatorAgent: "hermes",
          targetAgent: "codex",
          prompt: `task-${i}`,
        });
        tracker.recordOutputReceived({ delegationId: id });
        ids.push(id);
        now += 5_000;
      }
      now += 60_000;
      const pending = tracker.pendingNudges();
      expect(pending.map((r) => r.id)).toEqual(ids); // FIFO order
    });
  });

  describe("recordNudge", () => {
    it("bumps nudge_count + sets last_nudge_at + flips status awaiting → nudged", () => {
      const id = tracker.recordDelegation({
        initiatorAgent: "hermes",
        targetAgent: "codex",
        prompt: "x",
      });
      tracker.recordOutputReceived({ delegationId: id });
      now += 31_000;
      tracker.recordNudge(id);
      const row = tracker.find(id)!;
      expect(row.nudgeCount).toBe(1);
      expect(row.lastNudgeAt).toBe(now);
      expect(row.status).toBe("nudged");
    });
  });

  describe("recordEscalation", () => {
    it("flips status → escalated", () => {
      const id = tracker.recordDelegation({
        initiatorAgent: "hermes",
        targetAgent: "codex",
        prompt: "x",
      });
      tracker.recordOutputReceived({ delegationId: id });
      tracker.recordEscalation(id);
      expect(tracker.find(id)!.status).toBe("escalated");
    });
  });

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  describe("recentForAgent", () => {
    it("returns rows where the agent is either initiator OR target, newest first", () => {
      const as_initiator = tracker.recordDelegation({
        initiatorAgent: "hermes",
        targetAgent: "codex",
        prompt: "a",
      });
      now += 1_000;
      const as_target = tracker.recordDelegation({
        initiatorAgent: "openclaw",
        targetAgent: "hermes",
        prompt: "b",
      });
      now += 1_000;
      // Hermes appears in both
      const result = tracker.recentForAgent("hermes");
      const ids = result.map((r) => r.id);
      expect(ids).toContain(as_initiator);
      expect(ids).toContain(as_target);
      // Newest first
      expect(ids[0]).toBe(as_target);
    });

    it("respects the limit", () => {
      for (let i = 0; i < 25; i++) {
        tracker.recordDelegation({
          initiatorAgent: "hermes",
          targetAgent: "codex",
          prompt: `${i}`,
        });
        now += 100;
      }
      expect(tracker.recentForAgent("hermes", 10)).toHaveLength(10);
    });
  });
});

// =============================================================================
// Nudge / escalation text composition
// =============================================================================

describe("composeNudgeText", () => {
  function fakeRow(overrides: Record<string, unknown> = {}): {
    id: string;
    initiatorAgent: string;
    targetAgent: string;
    promptSummary: string;
    nudgeCount: number;
    spawnOutcome: string | null;
    [k: string]: unknown;
  } {
    return {
      id: "del-1",
      initiatorAgent: "hermes",
      targetAgent: "codex",
      promptSummary: "build the thing",
      nudgeCount: 0,
      spawnOutcome: "ok",
      ...overrides,
    };
  }

  it("includes the peer name, prompt summary, and a directive to act", () => {
    const text = composeNudgeText(
      fakeRow() as unknown as Parameters<typeof composeNudgeText>[0],
    );
    expect(text).toContain("codex");
    expect(text).toContain("build the thing");
    expect(text).toMatch(/next step|review|merge|don't go idle/i);
  });

  it("includes nudge counter after the first nudge", () => {
    const text = composeNudgeText(
      fakeRow({ nudgeCount: 1 }) as unknown as Parameters<
        typeof composeNudgeText
      >[0],
    );
    expect(text).toMatch(/nudge 2\/3/);
  });

  it("surfaces the spawn outcome when set", () => {
    const text = composeNudgeText(
      fakeRow({ spawnOutcome: "failed" }) as unknown as Parameters<
        typeof composeNudgeText
      >[0],
    );
    expect(text.toLowerCase()).toContain("failed");
  });
});

describe("composeEscalationText", () => {
  function fakeRow(overrides: Record<string, unknown> = {}): Parameters<
    typeof composeEscalationText
  >[0] {
    return {
      id: "del-1",
      initiatorAgent: "hermes",
      targetAgent: "codex",
      promptSummary: "build the thing",
      nudgeCount: 3,
      spawnOutcome: "ok",
      ...overrides,
    } as Parameters<typeof composeEscalationText>[0];
  }

  it("includes all key fields for the user to take over", () => {
    const text = composeEscalationText(fakeRow());
    expect(text).toContain("hermes");
    expect(text).toContain("codex");
    expect(text).toContain("build the thing");
    expect(text).toMatch(/foreman write hermes/);
    expect(text).toMatch(/stop/i);
  });
});

// =============================================================================
// Schema-level sanity — does the DB enforce what we expect?
// =============================================================================

describe("delegations table — schema constraints", () => {
  it("status defaults to 'open' when not specified", () => {
    const h = createInMemoryDb();
    const tr = new DelegationTracker({ db: h.db });
    try {
      const id = tr.recordDelegation({
        initiatorAgent: "hermes",
        targetAgent: "codex",
        prompt: "x",
      });
      const row = h.db
        .select()
        .from(delegations)
        .where(eq(delegations.id, id))
        .get()!;
      expect(row.status).toBe("open");
      expect(row.nudgeCount).toBe(0);
    } finally {
      h.sqlite.close();
    }
  });
});
