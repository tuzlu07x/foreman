import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentDaemonManager,
  type DaemonLifecycleEvent,
} from "../../src/core/agent-daemon-manager.js";
import { EventBus, type ForemanEventMap } from "../../src/core/event-bus.js";
import type { AgentEntry } from "../../src/core/registry-catalog.js";
import { RegistryService } from "../../src/core/registry.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";
import type { ForemanPaths } from "../../src/utils/config.js";

function makePaths(stateDir: string): ForemanPaths {
  return {
    root: stateDir,
    configDir: stateDir,
    stateDir,
    cacheDir: stateDir,
    legacyHome: null,
    policyPath: join(stateDir, "policy.yaml"),
    notifyConfigPath: join(stateDir, "notify.yaml"),
    notifyStatePath: join(stateDir, "notify-state.json"),
    llmConfigPath: join(stateDir, "llm.yaml"),
    voiceConfigPath: join(stateDir, "voice.yaml"),
    identityPath: join(stateDir, "identity"),
    soulPath: join(stateDir, "SOUL.md"),
    secretsKeyPath: join(stateDir, "secrets.key"),
    dbPath: join(stateDir, "foreman.db"),
    migrationsPath: join(stateDir, "migrations"),
  };
}

interface FakeChild extends EventEmitter {
  pid: number;
  stderr: EventEmitter;
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
}

function makeFakeChild(pid = 12345): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = vi.fn();
  child.unref = vi.fn();
  return child;
}

function fakeEntry(daemon: AgentEntry["daemon"] = { command: "hermes", args: ["gateway"] }): AgentEntry {
  return {
    id: "hermes",
    name: "Hermes",
    tagline: "test",
    homepage: "https://example.com/",
    install: { npm: null, brew: null },
    config_paths: [],
    required_secrets: [],
    optional_secrets: [],
    mcp_compatible: true,
    supported_versions: "*",
    min_foreman_version: "0.1.2",
    daemon,
  } as AgentEntry;
}

describe("AgentDaemonManager", () => {
  let stateDir: string;
  let paths: ForemanPaths;
  let db: ForemanDb;
  let sqlite: Database.Database;
  let bus: EventBus<ForemanEventMap>;
  let registry: RegistryService;
  let events: DaemonLifecycleEvent[];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "foreman-daemon-"));
    paths = makePaths(stateDir);
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    bus = new EventBus<ForemanEventMap>();
    registry = new RegistryService(db, bus);
    events = [];
  });

  afterEach(() => {
    sqlite.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  describe("startOne", () => {
    it("spawns the daemon command, writes a pidfile, and emits started", () => {
      const child = makeFakeChild(99001);
      const spawnImpl = vi.fn(() => child) as never;
      const mgr = new AgentDaemonManager({
        paths,
        registry,
        onLifecycle: (e) => events.push(e),
        spawnImpl,
      });
      mgr.startOne("hermes", fakeEntry());
      expect(spawnImpl).toHaveBeenCalledWith("hermes", ["gateway"], expect.objectContaining({ detached: false }));
      const pidfile = resolve(stateDir, "daemons", "hermes.pid");
      expect(existsSync(pidfile)).toBe(true);
      expect(readFileSync(pidfile, "utf-8")).toBe("99001");
      const started = events.find((e) => e.kind === "started");
      expect(started).toMatchObject({ kind: "started", agentId: "hermes", pid: 99001 });
      expect(child.unref).toHaveBeenCalled();
    });

    it("skips when no daemon block is declared", () => {
      const spawnImpl = vi.fn();
      const mgr = new AgentDaemonManager({
        paths,
        registry,
        onLifecycle: (e) => events.push(e),
        spawnImpl: spawnImpl as never,
      });
      mgr.startOne("codex", fakeEntry(null));
      expect(spawnImpl).not.toHaveBeenCalled();
      expect(events).toContainEqual({
        kind: "skipped",
        agentId: "codex",
        reason: "no daemon declared",
      });
    });

    it("is idempotent — second call on a tracked daemon skips with reason", () => {
      const child = makeFakeChild();
      const spawnImpl = vi.fn(() => child) as never;
      const mgr = new AgentDaemonManager({
        paths,
        registry,
        onLifecycle: (e) => events.push(e),
        spawnImpl,
      });
      mgr.startOne("hermes", fakeEntry());
      mgr.startOne("hermes", fakeEntry());
      expect(spawnImpl).toHaveBeenCalledTimes(1);
      expect(events.filter((e) => e.kind === "skipped")).toEqual([
        { kind: "skipped", agentId: "hermes", reason: "already tracked" },
      ]);
    });

    it("skips when an existing pidfile points at a live process", () => {
      // Use this test process's own PID — it's guaranteed alive.
      const pidfile = resolve(stateDir, "daemons", "hermes.pid");
      mkdirSync(dirname(pidfile), { recursive: true });
      writeFileSync(pidfile, String(process.pid), "utf-8");
      const spawnImpl = vi.fn();
      const mgr = new AgentDaemonManager({
        paths,
        registry,
        onLifecycle: (e) => events.push(e),
        spawnImpl: spawnImpl as never,
      });
      mgr.startOne("hermes", fakeEntry());
      expect(spawnImpl).not.toHaveBeenCalled();
      const skip = events.find((e) => e.kind === "skipped");
      expect(skip?.reason).toMatch(/already running/);
    });
  });

  describe("crash + clean exit", () => {
    it("emits crashed and clears the pidfile when child exits with non-zero", () => {
      const child = makeFakeChild();
      const spawnImpl = vi.fn(() => child) as never;
      const mgr = new AgentDaemonManager({
        paths,
        registry,
        onLifecycle: (e) => events.push(e),
        spawnImpl,
      });
      mgr.startOne("hermes", fakeEntry());
      const pidfile = resolve(stateDir, "daemons", "hermes.pid");
      expect(existsSync(pidfile)).toBe(true);
      child.stderr.emit("data", Buffer.from("connection refused\n"));
      child.emit("exit", 1);
      const crash = events.find((e) => e.kind === "crashed");
      expect(crash).toMatchObject({ kind: "crashed", exitCode: 1 });
      expect(crash && "stderr" in crash && crash.stderr).toContain("connection refused");
      expect(existsSync(pidfile)).toBe(false);
      const status = mgr.status("hermes");
      expect(status).toMatchObject({ state: "crashed", lastExitCode: 1 });
    });

    it("emits stopped (not crashed) when child exits with 0", () => {
      const child = makeFakeChild();
      const spawnImpl = vi.fn(() => child) as never;
      const mgr = new AgentDaemonManager({
        paths,
        registry,
        onLifecycle: (e) => events.push(e),
        spawnImpl,
      });
      mgr.startOne("hermes", fakeEntry());
      child.emit("exit", 0);
      const stopped = events.find((e) => e.kind === "stopped");
      expect(stopped).toBeDefined();
      const crash = events.find((e) => e.kind === "crashed");
      expect(crash).toBeUndefined();
    });
  });

  describe("stopOne / stopAll", () => {
    it("sends SIGTERM to the tracked process and removes pidfile", async () => {
      const child = makeFakeChild();
      const spawnImpl = vi.fn(() => child) as never;
      const mgr = new AgentDaemonManager({
        paths,
        registry,
        onLifecycle: (e) => events.push(e),
        spawnImpl,
      });
      mgr.startOne("hermes", fakeEntry());
      const pidfile = resolve(stateDir, "daemons", "hermes.pid");
      expect(existsSync(pidfile)).toBe(true);
      const stopPromise = mgr.stopOne("hermes");
      // Simulate clean shutdown — fire exit so waitForExit resolves.
      child.exitCode = 0;
      child.emit("exit", 0);
      await stopPromise;
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(existsSync(pidfile)).toBe(false);
      const stopped = events.filter((e) => e.kind === "stopped");
      expect(stopped.length).toBeGreaterThan(0);
    });

    it("falls back to SIGKILL when SIGTERM doesn't exit in time", async () => {
      vi.useFakeTimers();
      try {
        const child = makeFakeChild();
        const spawnImpl = vi.fn(() => child) as never;
        const mgr = new AgentDaemonManager({
          paths,
          registry,
          onLifecycle: (e) => events.push(e),
          spawnImpl,
        });
        mgr.startOne("hermes", fakeEntry());
        const stopPromise = mgr.stopOne("hermes");
        // Advance past STOP_GRACE_MS without firing exit — manager should
        // escalate to SIGKILL.
        await vi.advanceTimersByTimeAsync(6_000);
        child.emit("exit", null);
        await stopPromise;
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    });

    it("stopAll calls stopOne for every tracked daemon", async () => {
      const childA = makeFakeChild(100);
      const childB = makeFakeChild(200);
      let i = 0;
      const spawnImpl = vi.fn(() => (i++ === 0 ? childA : childB)) as never;
      const mgr = new AgentDaemonManager({
        paths,
        registry,
        onLifecycle: (e) => events.push(e),
        spawnImpl,
      });
      mgr.startOne("hermes", { ...fakeEntry(), id: "hermes" } as AgentEntry);
      mgr.startOne("openclaw", { ...fakeEntry({ command: "openclaw", args: ["gateway"] }), id: "openclaw" } as AgentEntry);
      const stopAll = mgr.stopAll();
      childA.exitCode = 0;
      childA.emit("exit", 0);
      childB.exitCode = 0;
      childB.emit("exit", 0);
      await stopAll;
      expect(childA.kill).toHaveBeenCalledWith("SIGTERM");
      expect(childB.kill).toHaveBeenCalledWith("SIGTERM");
    });
  });

  describe("status", () => {
    it("returns stopped for an unknown agent", () => {
      const mgr = new AgentDaemonManager({ paths, registry });
      expect(mgr.status("nobody")).toEqual({ state: "stopped" });
    });

    it("returns running for a tracked daemon", () => {
      const child = makeFakeChild(42);
      const spawnImpl = vi.fn(() => child) as never;
      const mgr = new AgentDaemonManager({ paths, registry, spawnImpl });
      mgr.startOne("hermes", fakeEntry());
      const status = mgr.status("hermes");
      expect(status.state).toBe("running");
      expect(status).toMatchObject({ pid: 42 });
    });
  });
});
