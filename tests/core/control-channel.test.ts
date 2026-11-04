import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ControlChannel,
  ControlDrainPoller,
  DEFAULT_MAX_PARALLEL_TASKS,
  isOwner,
  maxParallelTasks,
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
      const handler = vi.fn<ControlHandler>(() => ({ status: "applied" as const }));
      await channel.drainPending(new Map([["stop", handler]]));
      await channel.drainPending(new Map([["stop", handler]]));
      expect(handler).toHaveBeenCalledOnce();
    });

    it("a status write lost to a locked database is retried, never re-running the command (#594)", async () => {
      const { id } = channel.enqueue({ command: "write", args: ["codex", "task"], sourceAgent: "h" });
      const handler = vi.fn<ControlHandler>(() => ({ status: "applied" }));
      const handlers = new Map([["write", handler]]);
      const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      vi.spyOn(channel, "markApplied").mockImplementationOnce(() => {
        throw busy;
      });
      // The failure surfaces to the caller (the poller reports it)…
      await expect(channel.drainPending(handlers)).rejects.toThrow("database is locked");
      // …without a false "failed": the row is untouched.
      expect(channel.get(id)?.status).toBe("pending");
      // The next drain records the outcome it kept; the delegated agent
      // is not spawned a second time.
      await channel.drainPending(handlers);
      expect(handler).toHaveBeenCalledOnce();
      expect(channel.get(id)?.status).toBe("applied");
    });
  });
});

describe("running tasks side by side", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let channel: ControlChannel;
  /** Tasks in flight, finished by hand. */
  let open: Map<string, () => void>;
  let handlers: Map<string, ControlHandler>;

  const task = (agent: string, after?: number[]): number =>
    channel.enqueue({ command: "write", args: [agent, "do it"], sourceAgent: "cli", ...(after ? { after } : {}) }).id;
  const finish = async (agent: string): Promise<void> => {
    open.get(agent)!();
    open.delete(agent);
    await new Promise((r) => setImmediate(r));
  };
  const status = (id: number): string | undefined => channel.get(id)?.status;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    channel = new ControlChannel(db);
    open = new Map();
    handlers = new Map<string, ControlHandler>([
      [
        "write",
        (row) =>
          new Promise<ControlHandlerOutcome>((resolve) => {
            const [agent] = JSON.parse(row.args) as string[];
            open.set(agent!, () => resolve({ status: "applied" }));
          }),
      ],
      ["stop", async () => ({ status: "applied" })],
    ]);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("runs different agents at once and keeps one agent's tasks in order", async () => {
    task("backend");
    const second = task("backend");
    task("frontend");
    expect(channel.pump(handlers)).toBe(2);
    expect([...open.keys()].sort()).toEqual(["backend", "frontend"]);
    expect(channel.pump(handlers)).toBe(0);
    await finish("backend");
    expect(channel.pump(handlers)).toBe(1);
    expect(status(second)).toBe("pending");
    expect(open.has("backend")).toBe(true);
    await finish("backend");
    await finish("frontend");
    await channel.settled();
    expect(status(second)).toBe("applied");
  });

  it("stops at the limit and starts the rest as tasks finish", async () => {
    for (const agent of ["a", "b", "c"]) task(agent);
    expect(channel.pump(handlers, { maxTasks: 2 })).toBe(2);
    expect(channel.pump(handlers, { maxTasks: 2 })).toBe(0);
    await finish("a");
    expect(channel.pump(handlers, { maxTasks: 2 })).toBe(1);
    expect(open.has("c")).toBe(true);
  });

  it("doesn't make `stop` wait for a running task", async () => {
    task("backend");
    const stop = channel.enqueue({ command: "stop", args: [], sourceAgent: "cli" }).id;
    channel.pump(handlers, { maxTasks: 1 });
    await new Promise((r) => setImmediate(r));
    expect(status(stop)).toBe("applied");
    expect(open.has("backend")).toBe(true);
  });

  it("holds a task until the ones it waits for are done", async () => {
    const backend = task("backend");
    const frontend = task("frontend", [backend]);
    const tester = task("tester", [backend, frontend]);
    channel.pump(handlers);
    expect([...open.keys()]).toEqual(["backend"]);
    await finish("backend");
    channel.pump(handlers);
    expect([...open.keys()]).toEqual(["frontend"]);
    expect(status(tester)).toBe("pending");
    await finish("frontend");
    channel.pump(handlers);
    expect([...open.keys()]).toEqual(["tester"]);
  });

  it("doesn't start a task whose prerequisite failed, and says why", async () => {
    const backend = task("backend");
    const frontend = task("frontend", [backend]);
    channel.markFailed(backend, "crashed");
    channel.pump(handlers);
    expect(open.size).toBe(0);
    expect(channel.get(frontend)).toMatchObject({ status: "rejected", error: expect.stringContaining("backend") });
  });

  it("reads the limit from the environment, and falls back on nonsense", () => {
    expect(maxParallelTasks({})).toBe(DEFAULT_MAX_PARALLEL_TASKS);
    expect(maxParallelTasks({ FOREMAN_MAX_PARALLEL_TASKS: "2" })).toBe(2);
    expect(maxParallelTasks({ FOREMAN_MAX_PARALLEL_TASKS: "0" })).toBe(DEFAULT_MAX_PARALLEL_TASKS);
    expect(maxParallelTasks({ FOREMAN_MAX_PARALLEL_TASKS: "lots" })).toBe(DEFAULT_MAX_PARALLEL_TASKS);
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

  it("stop() waits for a command that is already running before it resolves", async () => {
    let release: () => void = () => {};
    const handler = vi.fn(
      () => new Promise<ControlHandlerOutcome>((r) => {
        release = () => r({ status: "applied" });
      }),
    );
    const poller = new ControlDrainPoller(channel, new Map([["stop", handler]]), { intervalMs: 100 });
    poller.start();
    channel.enqueue({ command: "stop", args: [], sourceAgent: "h" });
    await vi.advanceTimersByTimeAsync(150);
    expect(handler).toHaveBeenCalledOnce();
    let stopped = false;
    const stopping = poller.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(stopped).toBe(false); // the command is still running
    release();
    await stopping;
    expect(stopped).toBe(true);
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

  it("a failed drain is reported and retried, not left as an unhandled rejection (#594)", async () => {
    // Unhandled, this rejection used to take `foreman start` down.
    const drain = vi.spyOn(channel, "pump").mockImplementationOnce(() => {
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    });
    const errors: string[] = [];
    const poller = new ControlDrainPoller(channel, new Map(), {
      intervalMs: 100,
      onError: (m) => errors.push(m),
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(250);
    await poller.stop();
    expect(errors).toEqual([
      "control channel drain failed, retrying on the next tick: database is locked",
    ]);
    expect(drain).toHaveBeenCalledTimes(2);
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
