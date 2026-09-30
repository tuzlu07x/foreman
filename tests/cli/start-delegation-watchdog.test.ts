/**
 * Tests for `runDelegationWatchdog` — the per-tick driver wired into
 * `foreman start`'s 15s timer. The decisions live in DelegationLoop
 * (tests/core/delegation-loop.test.ts); here: the tick runs them, and a
 * delegate that has finished never produces a message to the owner (the
 * old watchdog pushed "nudge 2/3 … loop stuck" to the owner's chat).
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDelegationWatchdog } from "../../src/cli/start.js";
import { DelegationLoop } from "../../src/core/delegation-loop.js";
import { DelegationTracker } from "../../src/core/delegation-tracker.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";
import { controlCommands } from "../../src/db/schema.js";

describe("runDelegationWatchdog", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let now: number;
  let tracker: DelegationTracker;
  let loop: DelegationLoop;
  let escalations: string[];
  let enqueued: Array<{ agent: string; task: string }>;

  beforeEach(() => {
    const h = createInMemoryDb();
    db = h.db;
    sqlite = h.sqlite;
    now = 1_800_000_000_000;
    tracker = new DelegationTracker({ db, nowMs: () => now });
    escalations = [];
    enqueued = [];
    loop = new DelegationLoop({
      db,
      tracker,
      nowMs: () => now,
      enqueue: ({ agent, task }) => {
        enqueued.push({ agent, task });
        return db
          .insert(controlCommands)
          .values({ command: "write", args: JSON.stringify([agent, task]), sourceAgent: "foreman:delegation", status: "pending", createdAt: now })
          .returning({ id: controlCommands.id })
          .get()!.id;
      },
      launchRefusal: () => null,
      escalate: ({ text }) => escalations.push(text),
    });
  });

  afterEach(() => {
    sqlite.close();
  });

  it("does nothing for a delegation whose output arrived (the drain woke the sender)", () => {
    const id = tracker.recordDelegation({ initiatorAgent: "hermes", targetAgent: "codex", prompt: "build a thing" });
    tracker.recordOutputReceived({ delegationId: id, spawnOutcome: "ok" });
    now += 3 * 3_600_000;
    for (let i = 0; i < 5; i++) expect(runDelegationWatchdog({ loop })).toEqual({ nudged: 0, escalated: 0 });
    expect(enqueued).toEqual([]);
    expect(escalations).toEqual([]);
  });

  it("asks the agent that owes an answer, not the owner", () => {
    tracker.recordDelegation({ initiatorAgent: "hermes", targetAgent: "codex", prompt: "build a thing" });
    now += 31 * 60_000;
    expect(runDelegationWatchdog({ loop })).toEqual({ nudged: 1, escalated: 0 });
    expect(enqueued.map((e) => e.agent)).toEqual(["codex"]);
    expect(enqueued[0]!.task).toContain("hermes is still waiting for your answer");
    expect(escalations).toEqual([]);
  });
});
