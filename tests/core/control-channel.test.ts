import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ControlChannel,
  ControlDrainPoller,
  isOwner,
  type ControlHandler,
  type ControlHandlerOutcome,
  type OwnerStore,
} from "../../src/core/control-channel.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";

describe("ControlChannel (#440)", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let channel: ControlChannel;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    channel = new ControlChannel(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("enqueue + pending", () => {
    it("inserts a pending row + returns the id", () => {
      const enq = channel.enqueue({
        command: "stop",
        args: [],
        sourceAgent: "hermes",
        sourceUser: "tg:owner123",
      });
      expect(enq.id).toBeGreaterThan(0);
      const rows = channel.pending();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.command).toBe("stop");
      expect(rows[0]?.sourceAgent).toBe("hermes");
      expect(rows[0]?.sourceUser).toBe("tg:owner123");
      expect(rows[0]?.status).toBe("pending");
      expect(JSON.parse(rows[0]!.args)).toEqual([]);
    });

    it("serializes args as JSON", () => {
      channel.enqueue({
        command: "llm-switch",
        args: ["openai", "gpt-4o-mini"],
        sourceAgent: "hermes",
      });
      const rows = channel.pending();
      expect(JSON.parse(rows[0]!.args)).toEqual(["openai", "gpt-4o-mini"]);
    });

    it("returns rows in FIFO order", () => {
      channel.enqueue({ command: "a", args: [], sourceAgent: "h" });
      channel.enqueue({ command: "b", args: [], sourceAgent: "h" });
      channel.enqueue({ command: "c", args: [], sourceAgent: "h" });
      const rows = channel.pending();
      expect(rows.map((r) => r.command)).toEqual(["a", "b", "c"]);
    });

    it("respects the limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        channel.enqueue({ command: `c${i}`, args: [], sourceAgent: "h" });
      }
      expect(channel.pending(2)).toHaveLength(2);
      expect(channel.pending(10)).toHaveLength(5);
    });
  });

  describe("status transitions", () => {
    it("markApplied flips status + sets appliedAt", () => {
      const enq = channel.enqueue({
        command: "stop",
        args: [],
        sourceAgent: "h",
      });
      channel.markApplied(enq.id);
      const row = channel.get(enq.id);
      expect(row?.status).toBe("applied");
      expect(row?.appliedAt).not.toBeNull();
      expect(row?.error).toBeNull();
      expect(channel.pending()).toHaveLength(0);
    });

    it("markFailed records the error", () => {
      const enq = channel.enqueue({
        command: "stop",
        args: [],
        sourceAgent: "h",
      });
      channel.markFailed(enq.id, "boom");
      const row = channel.get(enq.id);
      expect(row?.status).toBe("failed");
      expect(row?.error).toBe("boom");
    });

    it("markRejected records the rejection reason", () => {
      const enq = channel.enqueue({
        command: "stop",
        args: [],
        sourceAgent: "h",
      });
      channel.markRejected(enq.id, "not owner");
      const row = channel.get(enq.id);
      expect(row?.status).toBe("rejected");
      expect(row?.error).toBe("not owner");
    });
  });

  describe("drainPending", () => {
    it("dispatches to the matching handler + marks applied", async () => {
      channel.enqueue({ command: "stop", args: [], sourceAgent: "h" });
      const stopHandler: ControlHandler = vi.fn(
        async (): Promise<ControlHandlerOutcome> => ({ status: "applied" }),
      );
      const count = await channel.drainPending(
        new Map([["stop", stopHandler]]),
      );
      expect(count).toBe(1);
      expect(stopHandler).toHaveBeenCalledOnce();
      expect(channel.pending()).toHaveLength(0);
    });

    it("rejects rows with no registered handler (unknown command)", async () => {
      const enq = channel.enqueue({
        command: "supernova",
        args: [],
        sourceAgent: "h",
      });
      const count = await channel.drainPending(new Map());
      expect(count).toBe(1);
      const row = channel.get(enq.id);
      expect(row?.status).toBe("rejected");
      expect(row?.error).toContain("Unknown control command");
    });

    it("marks failed when the handler throws", async () => {
      const enq = channel.enqueue({
        command: "stop",
        args: [],
        sourceAgent: "h",
      });
      const failing: ControlHandler = async () => {
        throw new Error("kaboom");
      };
      await channel.drainPending(new Map([["stop", failing]]));
      const row = channel.get(enq.id);
      expect(row?.status).toBe("failed");
      expect(row?.error).toBe("kaboom");
    });

    it("handler can return failed/rejected outcomes explicitly", async () => {
      channel.enqueue({ command: "a", args: [], sourceAgent: "h" });
      channel.enqueue({ command: "b", args: [], sourceAgent: "h" });
      const aHandler: ControlHandler = () => ({
        status: "failed",
        error: "a failed",
      });
      const bHandler: ControlHandler = () => ({
        status: "rejected",
        error: "b rejected",
      });
      await channel.drainPending(
        new Map([
          ["a", aHandler],
          ["b", bHandler],
        ]),
      );
      const rows = sqlite
        .prepare("SELECT command, status, error FROM control_commands ORDER BY id")
        .all() as Array<{ command: string; status: string; error: string }>;
      expect(rows[0]?.status).toBe("failed");
      expect(rows[1]?.status).toBe("rejected");
    });

    it("does not re-dispatch rows already applied", async () => {
      channel.enqueue({ command: "stop", args: [], sourceAgent: "h" });
      const handler: ControlHandler = vi.fn(() => ({ status: "applied" }));
      await channel.drainPending(new Map([["stop", handler]]));
      await channel.drainPending(new Map([["stop", handler]]));
      expect(handler).toHaveBeenCalledOnce();
    });
  });
});

describe("ControlDrainPoller (#440)", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let channel: ControlChannel;

  beforeEach(() => {
    vi.useFakeTimers();
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    channel = new ControlChannel(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    sqlite.close();
  });

  it("drains pending rows on each interval tick", async () => {
    const handler = vi.fn(
      async (): Promise<ControlHandlerOutcome> => ({ status: "applied" }),
    );
    const poller = new ControlDrainPoller(
      channel,
      new Map([["stop", handler]]),
      { intervalMs: 100 },
    );
    poller.start();
    channel.enqueue({ command: "stop", args: [], sourceAgent: "h" });
    await vi.advanceTimersByTimeAsync(150);
    expect(handler).toHaveBeenCalledOnce();
    poller.stop();
  });

  it("stop() cancels the timer", async () => {
    const handler = vi.fn(() => ({ status: "applied" as const }));
    const poller = new ControlDrainPoller(
      channel,
      new Map([["stop", handler]]),
      { intervalMs: 100 },
    );
    poller.start();
    poller.stop();
    channel.enqueue({ command: "stop", args: [], sourceAgent: "h" });
    await vi.advanceTimersByTimeAsync(500);
    expect(handler).not.toHaveBeenCalled();
  });

  it("start() is idempotent — calling twice doesn't double-fire", async () => {
    const handler = vi.fn(() => ({ status: "applied" as const }));
    const poller = new ControlDrainPoller(
      channel,
      new Map([["stop", handler]]),
      { intervalMs: 100 },
    );
    poller.start();
    poller.start();
    channel.enqueue({ command: "stop", args: [], sourceAgent: "h" });
    await vi.advanceTimersByTimeAsync(150);
    expect(handler).toHaveBeenCalledOnce();
    poller.stop();
  });
});

// #440 — E2E-ish: enqueue → drain → handler fires. Simulates the
// mcp-stdio → foreman start cross-process flow inside a single test
// process by using the same DB handle as both writer + reader.
describe("control channel E2E flow (#440)", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
  });

  afterEach(() => {
    sqlite.close();
  });

  it("simulates `/foreman stop` → handler fires + row marked applied", async () => {
    // mcp-stdio side: enqueue
    const writerChannel = new ControlChannel(db);
    writerChannel.enqueue({
      command: "stop",
      args: [],
      sourceAgent: "hermes",
      sourceUser: "owner123",
    });

    // foreman start side: drain
    const shutdownCalled = vi.fn();
    const readerChannel = new ControlChannel(db);
    const handlers = new Map<string, ControlHandler>([
      [
        "stop",
        async () => {
          shutdownCalled();
          return { status: "applied" };
        },
      ],
    ]);
    await readerChannel.drainPending(handlers);
    expect(shutdownCalled).toHaveBeenCalledOnce();
    expect(readerChannel.pending()).toHaveLength(0);
  });

  it("simulates `/foreman llm switch openai gpt-4o-mini` → handler picks up args", async () => {
    const writer = new ControlChannel(db);
    writer.enqueue({
      command: "llm-switch",
      args: ["openai", "gpt-4o-mini"],
      sourceAgent: "hermes",
      sourceUser: "owner",
    });
    const reader = new ControlChannel(db);
    const switchHandler = vi.fn(async (row): Promise<ControlHandlerOutcome> => {
      const args = JSON.parse(row.args) as string[];
      expect(args).toEqual(["openai", "gpt-4o-mini"]);
      return { status: "applied" };
    });
    await reader.drainPending(new Map([["llm-switch", switchHandler]]));
    expect(switchHandler).toHaveBeenCalledOnce();
  });
});

describe("isOwner (#440)", () => {
  function makeStore(secrets: Record<string, string>): OwnerStore {
    return {
      exists: (name) => name in secrets,
      get: (name) => {
        if (!(name in secrets)) throw new Error("missing");
        return secrets[name]!;
      },
    };
  }

  it("returns false when no sourceUser is supplied", () => {
    const store = makeStore({ "telegram-chat-id": "owner" });
    expect(isOwner(store, {})).toBe(false);
  });

  it("returns false when telegram-chat-id is not configured", () => {
    const store = makeStore({});
    expect(isOwner(store, { sourceUser: "owner" })).toBe(false);
  });

  it("returns true on exact match", () => {
    const store = makeStore({ "telegram-chat-id": "owner123" });
    expect(isOwner(store, { sourceUser: "owner123" })).toBe(true);
  });

  it("returns false on mismatch", () => {
    const store = makeStore({ "telegram-chat-id": "owner123" });
    expect(isOwner(store, { sourceUser: "owner999" })).toBe(false);
  });
});
