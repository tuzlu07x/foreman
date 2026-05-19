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
