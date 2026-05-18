import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { ForemanPaths } from "../utils/config.js";
import type { RegistryService } from "./registry.js";
import {
  findAgent,
  loadActiveRegistry,
  type AgentEntry,
} from "./registry-catalog.js";

// =============================================================================
// Agent daemon manager (#349)
// =============================================================================
//
// `foreman start` spawns the background daemon for every registered agent
// that declares one in registry/agents.json (e.g. Hermes → `hermes gateway`,
// OpenClaw → `openclaw gateway`). PIDs are tracked in
// `<stateDir>/daemons/<agentId>.pid` so:
//
//   - subsequent `foreman start` runs notice an already-running daemon and
//     skip re-spawning (idempotent)
//   - `foreman stop` (or Ctrl-C on the TUI) sends SIGTERM to every tracked
//     PID, waits up to 5s, then SIGKILL
//   - if foreman crashes hard, the pidfile survives so the next boot can
//     detect + reattach (we don't currently reattach — just skip if alive)
//
// Defensive: every spawn / pidfile operation is wrapped in try/catch so a
// single misconfigured agent can't keep foreman from booting. Crashes are
// surfaced via the bus (`agent:daemon-crashed`) so the TUI can show ✗ and
// v0.2 #309 can alert.

export type DaemonStatus =
  | { state: "running"; pid: number; startedAt: number }
  | { state: "stopped" }
  | { state: "crashed"; lastExitCode: number; lastStderr: string }
  | { state: "skipped"; reason: string };

export interface AgentDaemonManagerOptions {
  paths: ForemanPaths;
  registry: RegistryService;
  /** Emit lifecycle events on this bus when present. Optional so unit tests
   *  can skip the wiring. */
  onLifecycle?: (event: DaemonLifecycleEvent) => void;
  /** Override spawn for tests. */
  spawnImpl?: typeof spawn;
}

export type DaemonLifecycleEvent =
  | { kind: "started"; agentId: string; pid: number; command: string }
  | { kind: "stopped"; agentId: string; pid: number; reason: "user" | "shutdown" }
  | {
      kind: "crashed";
      agentId: string;
      pid: number;
      exitCode: number;
      stderr: string;
    }
  | { kind: "skipped"; agentId: string; reason: string };

interface TrackedDaemon {
  agentId: string;
  pid: number;
  process: ChildProcess;
  startedAt: number;
  command: string;
  capturedStderr: string;
}

const STOP_GRACE_MS = 5_000;
const STDERR_CAPTURE_BYTES = 8 * 1024;

export class AgentDaemonManager {
  private readonly paths: ForemanPaths;
  private readonly registry: RegistryService;
  private readonly onLifecycle?: (event: DaemonLifecycleEvent) => void;
  private readonly spawnImpl: typeof spawn;
  private readonly tracked = new Map<string, TrackedDaemon>();
  private readonly lastCrash = new Map<
    string,
    { exitCode: number; stderr: string }
  >();

  constructor(opts: AgentDaemonManagerOptions) {
    this.paths = opts.paths;
    this.registry = opts.registry;
    this.onLifecycle = opts.onLifecycle;
    this.spawnImpl = opts.spawnImpl ?? spawn;
  }

  /**
   * Spawn the daemon for every registered agent that declares one. Skips
   * agents without a daemon block + agents whose pidfile points at a
   * live process.
   */
  startAll(): void {
    let doc;
    try {
      doc = loadActiveRegistry().doc;
    } catch (err) {
      // Catalog unreadable — can't look up daemon commands. Skip silently;
      // doctor will surface the catalog problem separately.
      void err;
      return;
    }
    for (const agent of this.registry.list()) {
      try {
        const entry = findAgent(doc, agent.id);
        this.startOne(agent.id, entry);
      } catch {
        // Agent registered but not in active catalog (legacy / removed
        // registry entry). Skip — the registration is still valid for
        // policy / audit purposes, just no daemon to manage.
        this.emit({
          kind: "skipped",
          agentId: agent.id,
          reason: "agent not in active registry catalog",
        });
      }
    }
  }

  /** Spawn one agent's daemon. Idempotent — silently no-ops when already running. */
  startOne(agentId: string, entry: AgentEntry): void {
    if (!entry.daemon) {
      this.emit({ kind: "skipped", agentId, reason: "no daemon declared" });
      return;
    }
    if (this.tracked.has(agentId)) {
      this.emit({ kind: "skipped", agentId, reason: "already tracked" });
      return;
    }
    const existingPid = this.readPidfile(agentId);
    if (existingPid !== null && isProcessAlive(existingPid)) {
      this.emit({
        kind: "skipped",
        agentId,
        reason: `already running (pid ${existingPid})`,
      });
      return;
    }
    const command = entry.daemon.command;
    const args = entry.daemon.args ?? [];
    const child = this.spawnImpl(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    if (!child.pid) {
      this.emit({
        kind: "skipped",
        agentId,
        reason: `failed to spawn ${command}`,
      });
      return;
    }
    const tracked: TrackedDaemon = {
      agentId,
      pid: child.pid,
      process: child,
      startedAt: Date.now(),
      command: [command, ...args].join(" "),
      capturedStderr: "",
    };
    this.tracked.set(agentId, tracked);
    this.writePidfile(agentId, child.pid);
    child.stderr?.on("data", (chunk: Buffer) => {
      // Bound the captured stderr so a chatty daemon doesn't blow memory.
      const next = tracked.capturedStderr + chunk.toString("utf-8");
      tracked.capturedStderr = next.slice(-STDERR_CAPTURE_BYTES);
    });
    child.on("exit", (code) => {
      this.tracked.delete(agentId);
      this.removePidfile(agentId);
      if (code !== 0 && code !== null) {
        this.lastCrash.set(agentId, {
          exitCode: code,
          stderr: tracked.capturedStderr,
        });
        this.emit({
          kind: "crashed",
          agentId,
          pid: tracked.pid,
          exitCode: code,
          stderr: tracked.capturedStderr,
        });
      } else {
        this.emit({
          kind: "stopped",
          agentId,
          pid: tracked.pid,
          reason: "shutdown",
        });
      }
    });
    // Unref so the daemon doesn't keep the foreman process alive when the
    // user exits the TUI — we want explicit stop on SIGINT/SIGTERM via
    // stopAll(), not implicit "wait for child" semantics.
    child.unref();
    this.emit({
      kind: "started",
      agentId,
      pid: child.pid,
      command: tracked.command,
    });
  }

  /** SIGTERM every tracked daemon; wait up to STOP_GRACE_MS then SIGKILL. */
  async stopAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const agentId of Array.from(this.tracked.keys())) {
      promises.push(this.stopOne(agentId));
    }
    await Promise.all(promises);
  }

  async stopOne(agentId: string): Promise<void> {
    const tracked = this.tracked.get(agentId);
    if (!tracked) return;
    try {
      tracked.process.kill("SIGTERM");
    } catch {
      // Already dead — fall through to cleanup.
    }
    const exited = await waitForExit(tracked.process, STOP_GRACE_MS);
    if (!exited) {
      try {
        tracked.process.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
    // The exit handler will clean up the map + pidfile, but call them
    // explicitly to avoid a race where stopOne returns before 'exit' fires.
    this.tracked.delete(agentId);
    this.removePidfile(agentId);
    this.emit({
      kind: "stopped",
      agentId,
      pid: tracked.pid,
      reason: "user",
    });
  }

  /** Snapshot of every agent the manager knows about + its current state. */
  status(agentId: string): DaemonStatus {
    const tracked = this.tracked.get(agentId);
    if (tracked) {
      return {
        state: "running",
        pid: tracked.pid,
        startedAt: tracked.startedAt,
      };
    }
    const crash = this.lastCrash.get(agentId);
    if (crash) {
      return {
        state: "crashed",
        lastExitCode: crash.exitCode,
        lastStderr: crash.stderr,
      };
    }
    const pid = this.readPidfile(agentId);
    if (pid !== null && isProcessAlive(pid)) {
      return { state: "running", pid, startedAt: 0 };
    }
    return { state: "stopped" };
  }

  /** All tracked agent ids + their status. Convenience for TUI / CLI. */
  listStatuses(): Map<string, DaemonStatus> {
    const out = new Map<string, DaemonStatus>();
    for (const agentId of this.tracked.keys()) {
      out.set(agentId, this.status(agentId));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private emit(event: DaemonLifecycleEvent): void {
    if (this.onLifecycle) this.onLifecycle(event);
  }

  private pidfilePath(agentId: string): string {
    return resolve(this.paths.stateDir, "daemons", `${agentId}.pid`);
  }

  private writePidfile(agentId: string, pid: number): void {
    const path = this.pidfilePath(agentId);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, String(pid), "utf-8");
    } catch {
      // Pidfile write failures are non-fatal — the daemon still runs, we
      // just can't detect-on-next-boot. Doctor v0.2 can flag missing pidfiles.
    }
  }

  private readPidfile(agentId: string): number | null {
    const path = this.pidfilePath(agentId);
    if (!existsSync(path)) return null;
    try {
      const text = readFileSync(path, "utf-8").trim();
      const pid = parseInt(text, 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  private removePidfile(agentId: string): void {
    const path = this.pidfilePath(agentId);
    if (!existsSync(path)) return;
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolveFn) => {
    if (child.exitCode !== null) {
      resolveFn(true);
      return;
    }
    const timer = setTimeout(() => resolveFn(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveFn(true);
    });
  });
}
