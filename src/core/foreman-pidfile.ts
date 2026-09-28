import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
export function acquireForemanPidfile(configDir: string): void {
  const path = getForemanPidfilePath(configDir);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { encoding: "utf-8", flag: "wx", mode: 0o600 });
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
// malformed / points at a dead process. The caller treats null as
// "Foreman is not running" — same trust model as the agent daemon
// manager's pidfile-stale check.
export function readForemanPid(configDir: string): number | null {
  const path = getForemanPidfilePath(configDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    if (!isProcessAlive(pid)) return null;
    return pid;
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
