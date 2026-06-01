/**
 * Mediated spawn tests (#552 PR 4).
 *
 * Drives the full bridge + connector + spawn helper stack with a fake
 * codex child process (in-memory stdio). Covers:
 *
 *   - initialize handshake on spawn
 *   - thread/start + turn/start round-trips
 *   - mid-turn approval request → bridge → connector → mediator →
 *     adapter → wire response (allow + deny variants)
 *   - shutdown drains cleanly
 *   - argv override + invalid argv guard
 *
 * Uses EventEmitter-shaped fake ChildProcess + paired Readable/Writable
 * streams. No real codex binary is required, so the test is fast and
 * deterministic.
 */

import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";

import {
  spawnCodexMediated,
  type CodexSpawnLike,
} from "../../src/core/codex-mediated-spawn.js";
import type { MediatorLike } from "../../src/core/codex-mediator-connector.js";
import type { MediatorInput, MediatorOutput } from "../../src/core/mediator.js";

// =============================================================================
// Fixtures
// =============================================================================

interface FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  // vi.fn's inferred argument type is `[]` but ChildProcess.kill accepts a
  // signal arg. Use the widest mock signature so the assignment to the
  // FakeChild interface doesn't trip the variance check.
  kill: ReturnType<typeof vi.fn> & ((signal?: NodeJS.Signals) => boolean);
}

interface FakeSpawnHarness {
  spawn: CodexSpawnLike;
  child: FakeChild;
  /** Lines (no trailing newline) Foreman wrote to the child's stdin. */
  fromForeman: string[];
  /** Push a JSON-RPC frame as if codex emitted it on its stdout. */
  emit(frame: unknown): void;
  /** Push raw text — used for malformed-frame tests. */
  emitRaw(text: string): void;
  /** Wait one microtask tick so async handlers can run. */
  tick(): Promise<void>;
}

function makeFakeSpawn(): FakeSpawnHarness {
  const fromForeman: string[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const part of text.split("\n")) {
        if (part.length > 0) fromForeman.push(part);
      }
      cb();
    },
  });
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });

  const child = new EventEmitter() as FakeChild;
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn((_signal?: NodeJS.Signals) => true) as FakeChild["kill"];

  const spawn: CodexSpawnLike = vi.fn(() => child as unknown as ChildProcess);

  return {
    spawn,
    child,
    fromForeman,
    emit(frame) {
      stdout.push(JSON.stringify(frame) + "\n");
    },
    emitRaw(text) {
      stdout.push(text);
    },
    tick() {
      return new Promise((r) => setImmediate(r));
    },
  };
}

function mediatorReturning(
  decision: "allowed" | "denied",
  decidedBy = "risk:auto-allow",
  riskReasons: string[] = [],
): MediatorLike {
  const output: MediatorOutput = {
    requestId: "req_test",
    decision,
    decidedBy,
    riskScore: 10,
    riskReasons,
    riskFactors: [],
    riskBucket: "low",
    llmVerification: null,
    durationMs: 1,
  };
  return {
    handleRequest: vi.fn(
      async (_input: MediatorInput): Promise<MediatorOutput> => output,
    ),
  };
}

function parseFrame(line: string): {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
} {
  return JSON.parse(line);
}

// =============================================================================
// 1. Initialize handshake
// =============================================================================

describe("spawnCodexMediated — initialize handshake", () => {
  it("writes initialize with default clientInfo and resolves `ready` on success", async () => {
    const h = makeFakeSpawn();
    const session = spawnCodexMediated({
      mediator: mediatorReturning("allowed"),
      sourceAgent: "codex",
      spawnImpl: h.spawn,
    });

    await h.tick();
    expect(h.fromForeman).toHaveLength(1);
    const init = parseFrame(h.fromForeman[0]!);
    expect(init.method).toBe("initialize");
    const clientInfo = (
      init.params as { clientInfo: { name: string; version: string } }
    ).clientInfo;
    expect(clientInfo.name).toBe("foreman");
    expect(clientInfo.version).toMatch(/^\d+\.\d+\.\d+/);

    h.emit({ jsonrpc: "2.0", id: init.id, result: { ok: true } });
    await expect(session.ready).resolves.toEqual({ ok: true });

    await session.shutdown();
  });

  it("honors clientInfo override", async () => {
    const h = makeFakeSpawn();
    const session = spawnCodexMediated({
      mediator: mediatorReturning("allowed"),
      sourceAgent: "codex",
      spawnImpl: h.spawn,
      clientInfo: { name: "foreman-test", version: "1.2.3" },
    });
    await h.tick();
    const init = parseFrame(h.fromForeman[0]!);
    expect(
      (init.params as { clientInfo: { name: string; version: string } })
        .clientInfo,
    ).toEqual({
      name: "foreman-test",
      version: "1.2.3",
    });
    h.emit({ jsonrpc: "2.0", id: init.id, result: {} });
    await session.ready;
    await session.shutdown();
  });

  it("rejects `ready` when codex returns an initialize error", async () => {
    const h = makeFakeSpawn();
    const session = spawnCodexMediated({
      mediator: mediatorReturning("allowed"),
      sourceAgent: "codex",
      spawnImpl: h.spawn,
    });
    await h.tick();
    const init = parseFrame(h.fromForeman[0]!);
    h.emit({
      jsonrpc: "2.0",
      id: init.id,
      error: { code: -32602, message: "unsupported client" },
    });
    await expect(session.ready).rejects.toThrow(/unsupported client/);
    await session.shutdown();
  });
});

// =============================================================================
// 2. Spawn argv contract
// =============================================================================

describe("spawnCodexMediated — argv contract", () => {
  it("defaults to `codex exec-server --listen stdio`", async () => {
    const h = makeFakeSpawn();
    const session = spawnCodexMediated({
      mediator: mediatorReturning("allowed"),
      sourceAgent: "codex",
      spawnImpl: h.spawn,
    });
    await h.tick();
    const spawnMock = h.spawn as unknown as ReturnType<typeof vi.fn>;
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const callArgs = spawnMock.mock.calls[0]!;
    expect(callArgs[0]).toBe("codex");
    expect(callArgs[1]).toEqual(["exec-server", "--listen", "stdio"]);
    expect(callArgs[2].stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(callArgs[2].shell).toBe(false);
    h.emit({ jsonrpc: "2.0", id: 1, result: {} });
    await session.ready;
    await session.shutdown();
  });

  it("honors argv override (for fakes / non-default codex binary path)", async () => {
    const h = makeFakeSpawn();
    const session = spawnCodexMediated({
      mediator: mediatorReturning("allowed"),
      sourceAgent: "codex",
      spawnImpl: h.spawn,
      argv: { command: "/usr/local/bin/codex", args: ["exec-server"] },
    });
    await h.tick();
    const spawnMock = h.spawn as unknown as ReturnType<typeof vi.fn>;
    expect(spawnMock.mock.calls[0]![0]).toBe("/usr/local/bin/codex");
    expect(spawnMock.mock.calls[0]![1]).toEqual(["exec-server"]);
    h.emit({ jsonrpc: "2.0", id: 1, result: {} });
    await session.ready;
    await session.shutdown();
  });

  it("throws synchronously on empty argv command", () => {
    expect(() =>
      spawnCodexMediated({
        mediator: mediatorReturning("allowed"),
        sourceAgent: "codex",
        spawnImpl: makeFakeSpawn().spawn,
        argv: { command: "   ", args: [] },
      }),
    ).toThrow(/argv\.command is empty/);
  });

  it("cwd + env propagate to the spawn call", async () => {
    const h = makeFakeSpawn();
    const session = spawnCodexMediated({
      mediator: mediatorReturning("allowed"),
      sourceAgent: "codex",
      spawnImpl: h.spawn,
      cwd: "/tmp/some-work",
      env: { FOREMAN_TEST: "yes" },
    });
    await h.tick();
    const spawnMock = h.spawn as unknown as ReturnType<typeof vi.fn>;
    const opts = spawnMock.mock.calls[0]![2];
    expect(opts.cwd).toBe("/tmp/some-work");
    expect(opts.env.FOREMAN_TEST).toBe("yes");
    // process.env still passes through (we keep PATH etc.)
    expect(opts.env.PATH).toBeDefined();
    h.emit({ jsonrpc: "2.0", id: 1, result: {} });
    await session.ready;
    await session.shutdown();
  });
});

// =============================================================================
// 3. Full lifecycle — initialize → thread/start → turn/start → approval → done
// =============================================================================

describe("spawnCodexMediated — end-to-end lifecycle with mid-turn approval", () => {
  it("routes an approval through the connector and writes accept back to codex", async () => {
    const h = makeFakeSpawn();
    const mediator = mediatorReturning("allowed", "risk:auto-allow");
    const session = spawnCodexMediated({
      mediator,
      sourceAgent: "codex",
      spawnImpl: h.spawn,
    });

    // Initialize handshake.
    await h.tick();
    const init = parseFrame(h.fromForeman[0]!);
    h.emit({ jsonrpc: "2.0", id: init.id, result: { capabilities: {} } });
    await session.ready;

    // Caller starts a thread.
    const threadPromise = session.bridge.request("thread/start", {
      cwd: "/tmp",
    });
    await h.tick();
    const threadFrame = parseFrame(h.fromForeman[1]!);
    expect(threadFrame.method).toBe("thread/start");
    h.emit({
      jsonrpc: "2.0",
      id: threadFrame.id,
      result: { threadId: "thread_42" },
    });
    await expect(threadPromise).resolves.toEqual({ threadId: "thread_42" });

    // Caller starts a turn.
    const turnPromise = session.bridge.request("turn/start", {
      threadId: "thread_42",
      input: [{ type: "text", text: "ls /tmp" }],
    });
    await h.tick();
    const turnFrame = parseFrame(h.fromForeman[2]!);
    expect(turnFrame.method).toBe("turn/start");

    // Mid-turn: codex asks for approval. The connector decodes via the
    // adapter, runs the mediator (allowed), and writes back.
    h.emit({
      jsonrpc: "2.0",
      id: "approval-7",
      method: "item/commandExecution/requestApproval",
      params: {
        itemId: "item_X",
        threadId: "thread_42",
        turnId: "turn_77",
        startedAtMs: 1,
        command: "ls /tmp",
        cwd: "/tmp",
        reason: null,
        commandActions: null,
        networkApprovalContext: null,
        additionalPermissions: null,
        availableDecisions: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
        approvalId: null,
      },
    });
    await h.tick();
    await h.tick();

    // Foreman wrote 4 frames now: init, thread/start, turn/start, approval reply.
    expect(h.fromForeman.length).toBeGreaterThanOrEqual(4);
    const replyFrame = parseFrame(h.fromForeman[3]!);
    expect(replyFrame.id).toBe("approval-7");
    expect(replyFrame.result).toEqual({ decision: "accept" });

    // Codex notifies turn completion.
    h.emit({
      jsonrpc: "2.0",
      id: turnFrame.id,
      result: { status: "completed" },
    });
    await expect(turnPromise).resolves.toEqual({ status: "completed" });

    expect(mediator.handleRequest).toHaveBeenCalledTimes(1);
    const mArg = (mediator.handleRequest as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as MediatorInput;
    expect(mArg.sourceAgent).toBe("codex");
    expect(mArg.targetTool).toBe("shell_exec");

    await session.shutdown();
  });

  it("writes decline back when the mediator denies", async () => {
    const h = makeFakeSpawn();
    const mediator = mediatorReturning("denied", "risk:auto-deny", [
      "destructive_rm",
    ]);
    const session = spawnCodexMediated({
      mediator,
      sourceAgent: "codex",
      spawnImpl: h.spawn,
    });

    await h.tick();
    const init = parseFrame(h.fromForeman[0]!);
    h.emit({ jsonrpc: "2.0", id: init.id, result: {} });
    await session.ready;

    h.emit({
      jsonrpc: "2.0",
      id: "risky",
      method: "item/commandExecution/requestApproval",
      params: {
        itemId: "rm_X",
        threadId: "t",
        turnId: "tn",
        startedAtMs: 1,
        command: "rm -rf /",
        cwd: "/",
        reason: "agent decided",
        commandActions: null,
        networkApprovalContext: null,
        additionalPermissions: null,
        availableDecisions: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
        approvalId: null,
      },
    });
    await h.tick();
    await h.tick();

    const reply = parseFrame(h.fromForeman[1]!);
    expect(reply.id).toBe("risky");
    expect(reply.result).toEqual({ decision: "decline" });

    await session.shutdown();
  });
});

// =============================================================================
// 4. Shutdown semantics
// =============================================================================

describe("spawnCodexMediated — shutdown", () => {
  it("SIGTERMs the child and stops the bridge; pending requests reject", async () => {
    const h = makeFakeSpawn();
    const session = spawnCodexMediated({
      mediator: mediatorReturning("allowed"),
      sourceAgent: "codex",
      spawnImpl: h.spawn,
    });

    await h.tick();
    const init = parseFrame(h.fromForeman[0]!);
    h.emit({ jsonrpc: "2.0", id: init.id, result: {} });
    await session.ready;

    const orphan = session.bridge.request("thread/start", { cwd: "/" });
    await session.shutdown();
    expect(h.child.kill).toHaveBeenCalledWith("SIGTERM");

    await expect(orphan).rejects.toThrow(/stopped/);

    // shutdown is idempotent
    await session.shutdown();
    expect(h.child.kill).toHaveBeenCalledTimes(1);
  });
});
