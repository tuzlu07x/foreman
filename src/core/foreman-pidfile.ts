import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { uptime } from "node:os";
import { dirname, resolve } from "node:path";

// =============================================================================
// `foreman start` pidfile (#431 stop handler dependency)
// =============================================================================
//
// `foreman mcp-stdio` is a separate process from `foreman start`. They
// share state via SQLite, but signalling (`/foreman stop` from the
// mediator process to the start process) needs an out-of-band channel.
// Simplest: start writes its own PID to `<configDir>/foreman.pid` on
// boot, deletes it on shutdown. The stop command reads the file and
// sends SIGTERM. Same shape as the agent-daemon-manager pidfiles.

export function getForemanPidfilePath(configDir: string): string {
  return resolve(configDir, "foreman.pid");
}

// Writes the calling process's PID to the pidfile. Best-effort: any
// filesystem error is swallowed (we can't detect a stale pidfile on
// next boot — doctor v0.2 can flag missing/mismatched pidfiles).
export function writeForemanPidfile(configDir: string): void {
  const path = getForemanPidfilePath(configDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(process.pid), "utf-8");
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch {
    // Best-effort — start.ts continues even without a pidfile; the
    // worst case is `/foreman stop` can't find the PID and returns
    // a clear error message.
  }
}

/** Another `foreman start` owns this home (#657). */
export class ForemanAlreadyRunningError extends Error {
  constructor(
    readonly pid: number,
    readonly pidfile: string,
  ) {
    super(
      `Foreman is already running on this home (pid ${pid}). Use that window, or stop it first ` +
        `(Ctrl-C there, or /foreman stop). If pid ${pid} isn't Foreman, remove ${pidfile} and try again.`,
    );
    this.name = "ForemanAlreadyRunningError";
  }
}

/** The pid of another live `foreman start` on this home, or null. A
 *  pidfile left by a crash (dead or malformed pid) doesn't count. */
export function otherForemanPid(configDir: string): number | null {
  const pid = readForemanPid(configDir);
  return pid !== null && pid !== process.pid ? pid : null;
}

/**
 * Take the home for this `foreman start`: two on one home would both
 * answer approvals, poll the same bots and fight over the OTLP port
 * (#657). The pidfile is created exclusively; one left by a process that
 * is gone is stale and replaced. Throws ForemanAlreadyRunningError when
 * another live process holds it.
 */
export function acquireForemanPidfile(configDir: string, mode?: ForemanMode): void {
  const path = getForemanPidfilePath(configDir);
  mkdirSync(dirname(path), { recursive: true });
  // The pid stays alone on the first line, so older readers (and anything
  // that only parses an integer) keep working.
  const content = mode ? `${process.pid}\n${mode}\n` : String(process.pid);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        // No lock without a pidfile, as before: best-effort.
        return;
      }
    }
    const holder = otherForemanPid(configDir);
    if (holder !== null) throw new ForemanAlreadyRunningError(holder, path);
    // Stale (dead, malformed, or our own): replace it.
    try {
      rmSync(path, { force: true });
    } catch {
      return;
    }
  }
}

export function deleteForemanPidfile(configDir: string): void {
  const path = getForemanPidfilePath(configDir);
  try {
    if (existsSync(path)) rmSync(path);
  } catch {
    /* best-effort */
  }
}

// Returns the recorded PID, or null when the file is missing /
// malformed / stale (see readForemanPidInfo). The caller treats null as
// "Foreman is not running" — same trust model as the agent daemon
// manager's pidfile-stale check.
export function readForemanPid(configDir: string): number | null {
  return readForemanPidInfo(configDir)?.pid ?? null;
}

// =============================================================================
// Which Foreman holds the home: `foreman start` or the headless gateway
// =============================================================================
//
// Two kinds of process run the gateway (approval bridge, chat channels,
// control drain, schedulers): `foreman start` with its TUI ("tui"), and
// the background service's `foreman daemon --service` without one
// ("headless"). The pidfile says which on its second line, and the holder
// refreshes the file's mtime every few seconds (a heartbeat). A
// `foreman start` that finds a live headless gateway attaches to it and
// runs only the TUI.

export type ForemanMode = "tui" | "headless";

/** How often the holder refreshes the pidfile's mtime. */
export const PIDFILE_HEARTBEAT_MS = 5_000;
/** A heartbeat older than this is suspicious: the pid then only counts if
 *  that process is recognisably Foreman. */
export const PIDFILE_STALE_MS = 30_000;

export interface ForemanPidInfo {
  pid: number;
  /** null: a pidfile written without a mode (a Foreman before the headless
   *  gateway, or a caller that passed none) — treated as a TUI. */
  mode: ForemanMode | null;
  /** Milliseconds since the last heartbeat (the file's mtime). */
  heartbeatAgeMs: number;
}

/** Test seams for liveness and identity. */
export interface PidProbe {
  alive?: (pid: number) => boolean;
  /** The process's command line, or null when it can't be read. */
  command?: (pid: number) => string | null;
  now?: () => number;
  /** When this machine booted (ms since the epoch). */
  bootTime?: () => number;
}

/**
 * The live Foreman that holds this home, or null. A stale pidfile doesn't
 * count:
 *   - a dead or malformed pid (a crash, a kill -9);
 *   - a file last written before this machine booted: its pid has been
 *     handed out again since (common right after a reboot, when the
 *     service starts at login and pids are small);
 *   - a heartbeat that stopped (files with a mode only) and a process that
 *     isn't Foreman: the pid was reused within this boot.
 * A Foreman whose heartbeat is merely late (a busy event loop, a machine
 * that just woke up) still counts: two gateways on one home would be worse
 * than a refused start.
 */
export function readForemanPidInfo(configDir: string, probe: PidProbe = {}): ForemanPidInfo | null {
  const path = getForemanPidfilePath(configDir);
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(path, "utf-8");
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  const [first = "", second = ""] = raw.split("\n");
  const pid = Number.parseInt(first.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const modeText = second.trim();
  const mode: ForemanMode | null = modeText === "tui" || modeText === "headless" ? modeText : null;
  if (!(probe.alive ?? isProcessAlive)(pid)) return null;
  const now = (probe.now ?? Date.now)();
  // A minute of slack: uptime() is whole seconds, and clocks drift.
  if (mtimeMs < (probe.bootTime ?? machineBootTime)() - 60_000) return null;
  const heartbeatAgeMs = Math.max(0, now - mtimeMs);
  if (mode !== null && heartbeatAgeMs > PIDFILE_STALE_MS && pid !== process.pid) {
    const command = (probe.command ?? processCommand)(pid);
    if (command !== null && !/foreman/i.test(command)) return null;
  }
  return { pid, mode, heartbeatAgeMs };
}

/** Refresh the heartbeat, only on a pidfile that is still this process's. */
export function touchForemanPidfile(configDir: string): void {
  const path = getForemanPidfilePath(configDir);
  try {
    if (readFileSync(path, "utf-8").split("\n")[0]?.trim() !== String(process.pid)) return;
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    // gone (shutting down) or unreadable: nothing to refresh
  }
}

/** Remove the pidfile only while it is this process's: a gateway that took
 *  over in the meantime keeps its own. */
export function releaseForemanPidfile(configDir: string): void {
  const path = getForemanPidfilePath(configDir);
  try {
    if (readFileSync(path, "utf-8").split("\n")[0]?.trim() === String(process.pid)) rmSync(path);
  } catch {
    /* best-effort */
  }
}

function machineBootTime(): number {
  return Date.now() - uptime() * 1000;
}

/** `ps` for one pid's command line; null when it can't be read. */
function processCommand(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    const res = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf-8", timeout: 2_000 });
    const out = res.status === 0 ? res.stdout.trim() : "";
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

// `process.kill(pid, 0)` doesn't actually send a signal — it just
// checks reachability + permission. Throws when the process is gone.
// Skip the check on Windows where signal=0 semantics differ.
function isProcessAlive(pid: number): boolean {
  if (process.platform === "win32") return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
