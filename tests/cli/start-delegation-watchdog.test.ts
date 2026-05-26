/**
 * Tests for `runDelegationWatchdog` — the per-tick driver wired into
 * `foreman start`'s 15s timer.
 *
 * The fixture sets up:
 *   - in-memory SQLite with the delegations table
 *   - a DelegationTracker with controlled clock + thresholds
 *   - a fake fetch that captures every Telegram sendMessage call
 *
 * Then exercises the full lifecycle: insert delegation → output
 * received → tick before threshold (no nudge) → tick past threshold
 * (nudge fires) → tick past max nudges (escalation fires).
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDelegationWatchdog } from "../../src/cli/start.js";
import { DelegationTracker } from "../../src/core/delegation-tracker.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";

interface FakeFetchCall {
  url: string;
  body: { chat_id: string; text: string };
}

function makeFakeFetch(): {
  fetch: typeof fetch;
  calls: FakeFetchCall[];
} {
  const calls: FakeFetchCall[] = [];
  const fakeFetch: typeof fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as FakeFetchCall["body"];
    calls.push({ url: String(url), body });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, calls };
}

describe("runDelegationWatchdog", () => {
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
  // Tick semantics
  // -------------------------------------------------------------------------

  it("does nothing when no delegations have crossed the threshold", async () => {
    const id = tracker.recordDelegation({
      initiatorAgent: "hermes",
      targetAgent: "codex",
      prompt: "x",
    });
    tracker.recordOutputReceived({ delegationId: id });
    // < threshold
    now += 10_000;
    const { fetch: fakeFetch, calls } = makeFakeFetch();
    const result = await runDelegationWatchdog({
      tracker,
      telegramBotToken: "TEST",
      telegramChatId: "123",
      fetchImpl: fakeFetch,
    });
    expect(result).toEqual({ nudged: 0, escalated: 0 });
    expect(calls).toEqual([]);
  });

  it("nudges + records nudge on a delegation past the threshold", async () => {
    const id = tracker.recordDelegation({
      initiatorAgent: "hermes",
      targetAgent: "codex",
      prompt: "build a thing",
    });
    tracker.recordOutputReceived({ delegationId: id, spawnOutcome: "ok" });
    now += 31_000;
    const { fetch: fakeFetch, calls } = makeFakeFetch();
    const result = await runDelegationWatchdog({
      tracker,
      telegramBotToken: "TEST",
      telegramChatId: "123",
      fetchImpl: fakeFetch,
    });
    expect(result.nudged).toBe(1);
    expect(result.escalated).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.chat_id).toBe("123");
    expect(calls[0]!.body.text).toContain("codex");
    expect(calls[0]!.body.text).toContain("build a thing");
    // DB advances:
    expect(tracker.find(id)!.status).toBe("nudged");
    expect(tracker.find(id)!.nudgeCount).toBe(1);
  });

  it("escalates instead of nudging on the final attempt (nudgeCount + 1 >= max)", async () => {
    const id = tracker.recordDelegation({
      initiatorAgent: "hermes",
      targetAgent: "codex",
      prompt: "x",
    });
    tracker.recordOutputReceived({ delegationId: id });
    now += 60_000;
    // Bring it up to (maxNudges - 1) so the next tick fires the
    // escalation path instead of a normal nudge.
    tracker.recordNudge(id);
    now += 31_000;
    tracker.recordNudge(id);
    now += 31_000;
    expect(tracker.find(id)!.nudgeCount).toBe(2); // max = 3, next is final

    const { fetch: fakeFetch, calls } = makeFakeFetch();
    const result = await runDelegationWatchdog({
      tracker,
      telegramBotToken: "TEST",
      telegramChatId: "123",
      fetchImpl: fakeFetch,
    });
    expect(result.escalated).toBe(1);
    expect(result.nudged).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.text).toMatch(/loop stuck|escalation/i);
    expect(tracker.find(id)!.status).toBe("escalated");
  });

  // -------------------------------------------------------------------------
  // Skip rules
  // -------------------------------------------------------------------------

  it("skips delegations initiated by 'cli' (terminal user — no chat to nudge)", async () => {
    const id = tracker.recordDelegation({
      initiatorAgent: "cli",
      targetAgent: "codex",
      prompt: "x",
    });
    tracker.recordOutputReceived({ delegationId: id });
    now += 60_000;
    const { fetch: fakeFetch, calls } = makeFakeFetch();
    const result = await runDelegationWatchdog({
      tracker,
      telegramBotToken: "TEST",
      telegramChatId: "123",
      fetchImpl: fakeFetch,
    });
    expect(result).toEqual({ nudged: 0, escalated: 0 });
    expect(calls).toEqual([]);
    // Row stays in awaiting — the watchdog didn't claim it, but the
    // tracker also didn't process it. This is intentional: if a future
    // CLI surfaces emerges (a wrap-style CLI relay), it can pick up
    // these untouched rows.
    expect(tracker.find(id)!.status).toBe("awaiting");
  });

  it("advances DB state even when Telegram credentials are missing (no push, no error)", async () => {
    const id = tracker.recordDelegation({
      initiatorAgent: "hermes",
      targetAgent: "codex",
      prompt: "x",
    });
    tracker.recordOutputReceived({ delegationId: id });
    now += 60_000;
    const { fetch: fakeFetch, calls } = makeFakeFetch();
    const result = await runDelegationWatchdog({
      tracker,
      // No bot token / chat id wired
      fetchImpl: fakeFetch,
    });
    expect(result.nudged).toBe(1);
    expect(calls).toEqual([]); // no outbound push attempted
    expect(tracker.find(id)!.status).toBe("nudged"); // DB still advances
  });

  // -------------------------------------------------------------------------
  // Resilience
  // -------------------------------------------------------------------------

  it("continues processing other rows when one push fails", async () => {
    const id1 = tracker.recordDelegation({
      initiatorAgent: "hermes",
      targetAgent: "codex",
      prompt: "first",
    });
    const id2 = tracker.recordDelegation({
      initiatorAgent: "hermes",
      targetAgent: "codex",
      prompt: "second",
    });
    tracker.recordOutputReceived({ delegationId: id1 });
    tracker.recordOutputReceived({ delegationId: id2 });
    now += 60_000;

    // Fake fetch that throws on the first call, succeeds on the second.
    let calls = 0;
    const flakyFetch: typeof fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("network exploded");
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runDelegationWatchdog({
      tracker,
      telegramBotToken: "TEST",
      telegramChatId: "123",
      fetchImpl: flakyFetch,
    });
    // Both still record DB state — push failure doesn't poison the
    // tracker.
    expect(result.nudged).toBe(2);
    expect(calls).toBe(2);
    expect(tracker.find(id1)!.status).toBe("nudged");
    expect(tracker.find(id2)!.status).toBe("nudged");
  });

  // -------------------------------------------------------------------------
  // Integration with the full happy path
  // -------------------------------------------------------------------------

  it("full lifecycle: delegate → output → nudge → initiator acts → row closes (no further nudges)", async () => {
    const id = tracker.recordDelegation({
      initiatorAgent: "hermes",
      targetAgent: "codex",
      prompt: "build it",
    });
    tracker.recordOutputReceived({ delegationId: id, spawnOutcome: "ok" });

    // First tick — still inside the threshold, no nudge.
    now += 10_000;
    const f1 = makeFakeFetch();
    await runDelegationWatchdog({
      tracker,
      telegramBotToken: "T",
      telegramChatId: "C",
      fetchImpl: f1.fetch,
    });
    expect(f1.calls).toHaveLength(0);

    // Second tick — past threshold, nudge fires.
    now += 25_000;
    const f2 = makeFakeFetch();
    await runDelegationWatchdog({
      tracker,
      telegramBotToken: "T",
      telegramChatId: "C",
      fetchImpl: f2.fetch,
    });
    expect(f2.calls).toHaveLength(1);
    expect(tracker.find(id)!.status).toBe("nudged");

    // Initiator (Hermes) acts: closeOpenInitiatorRows simulates a new
    // `foreman write` arriving from Hermes.
    now += 5_000;
    tracker.closeOpenInitiatorRows("hermes");
    expect(tracker.find(id)!.status).toBe("closed");
    expect(tracker.find(id)!.followUpAt).toBe(now);

    // Third tick — well past everything, but row is closed → no nudge.
    now += 60_000;
    const f3 = makeFakeFetch();
    await runDelegationWatchdog({
      tracker,
      telegramBotToken: "T",
      telegramChatId: "C",
      fetchImpl: f3.fetch,
    });
    expect(f3.calls).toHaveLength(0);
  });
});
