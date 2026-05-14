import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BusApprovalService } from "../../src/core/approval.js";
import { EventBus, type ForemanEventMap } from "../../src/core/event-bus.js";
import { MediatorService } from "../../src/core/mediator.js";
import { PolicyEngine } from "../../src/core/policy-engine.js";
import { RegistryService } from "../../src/core/registry.js";
import { RiskScorer } from "../../src/core/risk-scorer.js";
import {
  runWrap,
  type WrapTransport,
  type WrapTransportFactory,
  type WrapTransportFactoryOptions,
} from "../../src/core/wrap-runner.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";
import type { JSONRPCMessage } from "../../src/mcp/types.js";

// In-memory fake transport. The runner drives it with `start`, `send`, `stop`;
// the test drives it with `inject(...)` to simulate the child writing to stdout
// and `triggerExit(...)` to simulate the child dying.
function makeFakeTransport(): {
  factory: WrapTransportFactory;
  instance: () => FakeTransport;
} {
  let instance: FakeTransport | null = null;
  return {
    factory: (opts) => {
      instance = new FakeTransport(opts);
      return instance;
    },
    instance: () => {
      if (!instance) throw new Error("transport not constructed yet");
      return instance;
    },
  };
}

class FakeTransport implements WrapTransport {
  public started = false;
  public stopped = false;
  public readonly sent: JSONRPCMessage[] = [];
  constructor(private readonly opts: WrapTransportFactoryOptions) {}
  start(): void {
    this.started = true;
  }
  send(msg: JSONRPCMessage): void {
    this.sent.push(msg);
  }
  stop(): void {
    this.stopped = true;
  }
  isAlive(): boolean {
    return this.started && !this.stopped;
  }
  pid(): number | undefined {
    return 12345;
  }
  inject(msg: JSONRPCMessage): void {
    this.opts.onMessage(msg);
  }
  triggerExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.opts.onExit(code, signal);
  }
  triggerError(err: Error): void {
    this.opts.onError(err);
  }
}

function buildServices(
  db: ForemanDb,
  bus: EventBus<ForemanEventMap>,
): { mediator: MediatorService; registry: RegistryService; policy: PolicyEngine } {
  const registry = new RegistryService(db, bus);
  const policy = new PolicyEngine(db, bus);
  const mediator = new MediatorService({
    registry,
    policy,
    risk: new RiskScorer(db),
    approval: new BusApprovalService({ bus, timeoutMs: 100 }),
    db,
    bus,
  });
  return { registry, policy, mediator };
}

describe("runWrap", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let bus: EventBus<ForemanEventMap>;
  let registry: RegistryService;
  let policy: PolicyEngine;
  let mediator: MediatorService;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    bus = new EventBus<ForemanEventMap>();
    const services = buildServices(db, bus);
    registry = services.registry;
    policy = services.policy;
    mediator = services.mediator;
  });

  afterEach(() => {
    sqlite.close();
  });

  it("registers the agent on first wrap and emits the private key once", () => {
    const t = makeFakeTransport();
    const logs: string[] = [];
    const session = runWrap({
      agentId: "py-agent",
      command: "irrelevant",
      args: [],
      registry,
      mediator,
      transportFactory: t.factory,
      onLog: (line) => logs.push(line),
    });
    expect(session.privateKey).toBeDefined();
    expect(session.privateKey?.length).toBe(32);
    expect(registry.get("py-agent")?.transport).toBe("wrap");
    expect(logs.some((l) => l.includes("registered new agent"))).toBe(true);
    expect(t.instance().started).toBe(true);
    session.stop();
    t.instance().triggerExit(0);
    return session.done;
  });

  it("reuses the existing identity on a second wrap (no new keypair)", async () => {
    registry.register({
      id: "py-agent",
      displayName: "py-agent",
      transport: "wrap",
    });
    const t = makeFakeTransport();
    const logs: string[] = [];
    const session = runWrap({
      agentId: "py-agent",
      command: "irrelevant",
      args: [],
      registry,
      mediator,
      transportFactory: t.factory,
      onLog: (line) => logs.push(line),
    });
    expect(session.privateKey).toBeUndefined();
    expect(logs.some((l) => l.includes("reusing existing identity"))).toBe(true);
    session.stop();
    t.instance().triggerExit(0);
    await session.done;
  });

  it("routes a tool call through the mediator and writes the response back to the child", async () => {
    policy.loadYamlText(`
rules:
  - source: "*"
    target: "tool:list_files"
    effect: allow
`);
    const t = makeFakeTransport();
    runWrap({
      agentId: "py-agent",
      command: "x",
      args: [],
      registry,
      mediator,
      transportFactory: t.factory,
      onLog: () => {},
    });
    t.instance().inject({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_files", arguments: { path: "." } },
    } as JSONRPCMessage);
    // Yield so the async mediator handler can complete.
    await new Promise((r) => setTimeout(r, 10));
    expect(t.instance().sent).toHaveLength(1);
    const sent = t.instance().sent[0] as unknown as {
      id: number;
      result?: { content: { text: string }[] };
      error?: { code: number; message: string };
    };
    expect(sent.id).toBe(1);
    expect(sent.result?.content[0]?.text).toMatch(/allowed by/);
  });

  it("writes a JSON-RPC error when the mediator denies the call", async () => {
    policy.loadYamlText(`
rules:
  - source: "*"
    target: "tool:shell_exec"
    effect: deny
`);
    const t = makeFakeTransport();
    runWrap({
      agentId: "py-agent",
      command: "x",
      args: [],
      registry,
      mediator,
      transportFactory: t.factory,
      onLog: () => {},
    });
    t.instance().inject({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "shell_exec", arguments: { command: "rm -rf /" } },
    } as JSONRPCMessage);
    await new Promise((r) => setTimeout(r, 10));
    const sent = t.instance().sent[0] as unknown as {
      id: number;
      error?: { code: number; message: string };
    };
    expect(sent.error?.code).toBe(-32603);
    expect(sent.error?.message).toMatch(/Denied by/);
  });

  it("ignores notifications and responses from the child (no id, no method)", async () => {
    const t = makeFakeTransport();
    runWrap({
      agentId: "py-agent",
      command: "x",
      args: [],
      registry,
      mediator,
      transportFactory: t.factory,
      onLog: () => {},
    });
    // Notification (method but no id): not answered.
    t.instance().inject({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {},
    } as JSONRPCMessage);
    // Response back from the child (id but no method): not answered either.
    t.instance().inject({
      jsonrpc: "2.0",
      id: 99,
      result: {},
    } as unknown as JSONRPCMessage);
    await new Promise((r) => setTimeout(r, 10));
    expect(t.instance().sent).toHaveLength(0);
  });

  it("resolves done with the child's exit code on a clean exit", async () => {
    const t = makeFakeTransport();
    const session = runWrap({
      agentId: "py-agent",
      command: "x",
      args: [],
      registry,
      mediator,
      transportFactory: t.factory,
      onLog: () => {},
    });
    t.instance().triggerExit(0);
    await expect(session.done).resolves.toBe(0);
  });

  it("resolves done with exit 1 on transport error (e.g. spawn ENOENT)", async () => {
    const t = makeFakeTransport();
    const logs: string[] = [];
    const session = runWrap({
      agentId: "py-agent",
      command: "x",
      args: [],
      registry,
      mediator,
      transportFactory: t.factory,
      onLog: (line) => logs.push(line),
    });
    t.instance().triggerError(new Error("spawn /bin/false ENOENT"));
    await expect(session.done).resolves.toBe(1);
    expect(logs.some((l) => l.includes("transport error"))).toBe(true);
  });

  it("stop() flags the transport and resolves with the exit code", async () => {
    const t = makeFakeTransport();
    const session = runWrap({
      agentId: "py-agent",
      command: "x",
      args: [],
      registry,
      mediator,
      transportFactory: t.factory,
      onLog: () => {},
    });
    session.stop();
    expect(t.instance().stopped).toBe(true);
    t.instance().triggerExit(143, "SIGTERM");
    await expect(session.done).resolves.toBe(143);
  });

  it("with --restart on-failure re-creates the transport when the child exits non-zero", async () => {
    let instanceCount = 0;
    const instances: FakeTransport[] = [];
    const factory: WrapTransportFactory = (opts) => {
      const inst = new FakeTransport(opts);
      instances.push(inst);
      instanceCount += 1;
      return inst;
    };
    vi.useFakeTimers();
    const session = runWrap({
      agentId: "py-agent",
      command: "x",
      args: [],
      restart: "on-failure",
      registry,
      mediator,
      transportFactory: factory,
      onLog: () => {},
    });
    expect(instanceCount).toBe(1);
    instances[0]!.triggerExit(1);
    await vi.advanceTimersByTimeAsync(1100);
    expect(instanceCount).toBe(2);
    session.stop();
    instances[1]!.triggerExit(0);
    vi.useRealTimers();
    await session.done;
  });
});
