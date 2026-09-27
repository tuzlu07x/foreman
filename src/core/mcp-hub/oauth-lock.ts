import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, linkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { McpOAuthError } from "./oauth-http.js";

// =============================================================================
// Cross-process lock for a hub OAuth session
// =============================================================================
//
// Every write to a stored session (refresh, login, logout, remove) runs
// under this lock, so a rotated refresh token is never presented twice and a
// logout cannot be undone by a refresh that was already in flight.
//
// The lock file holds `<pid>:<nonce>`. A holder removes it only while it
// still holds its own nonce. A lock whose holder process is gone, or which is
// older than `staleMs`, is broken by renaming it aside (atomic) and checking
// the renamed file is the one that was judged stale. By default `staleMs`
// is shorter than `waitMs`, so a waiter outlives a hung holder. Every retry
// sleeps; nothing here spins.

export interface LockOptions {
  /** Give up after this long. */
  waitMs?: number;
  /** A lock older than this is broken even if its holder still runs. */
  staleMs?: number;
}

/** Longest a holder keeps the lock: one token request (see oauth-http). */
export const LOCK_STALE_MS = 20_000;
export const LOCK_WAIT_MS = 30_000;

export async function withLockFile<T>(path: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = `${process.pid}:${randomBytes(12).toString("hex")}`;
  const deadline = Date.now() + waitMs;
  while (!tryCreate(path, token)) {
    breakIfStale(path, staleMs);
    if (Date.now() >= deadline) {
      throw new McpOAuthError(`timed out waiting for the OAuth session lock (${path})`);
    }
    await delay(20 + Math.floor(Math.random() * 40));
  }
  try {
    return await fn();
  } finally {
    releaseIfOurs(path, token);
  }
}

function tryCreate(path: string, token: string): boolean {
  try {
    // O_CREAT | O_EXCL: fails on any existing entry, symlinks included.
    writeFileSync(path, token, { flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      assertRegularFile(path);
      return false;
    }
    throw new McpOAuthError(`cannot create the OAuth session lock ${path}: ${(err as Error).message}`);
  }
}

/** A directory, symlink or device at the lock path is never ours to remove;
 *  fail at once instead of waiting on something that will never go away. */
function assertRegularFile(path: string): void {
  let isFile: boolean;
  try {
    isFile = lstatSync(path).isFile();
  } catch {
    return; // vanished meanwhile — the next attempt may succeed
  }
  if (!isFile) {
    throw new McpOAuthError(`the OAuth session lock path ${path} is not a regular file — remove it`);
  }
}

function breakIfStale(path: string, staleMs: number): void {
  let holder: string;
  let ageMs: number;
  try {
    ageMs = Date.now() - lstatSync(path).mtimeMs;
    holder = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  if (ageMs <= staleMs && processAlive(holder)) return;
  const aside = `${path}.stale-${randomBytes(6).toString("hex")}`;
  try {
    renameSync(path, aside);
  } catch {
    return; // someone else broke (or released) it first
  }
  let moved = "";
  try {
    moved = readFileSync(aside, "utf-8");
  } catch {
    // unreadable — treat as ours to discard
  }
  if (moved !== holder) {
    // We moved a lock taken after our check: hand it back if the path is
    // still free (a hard link keeps the holder's nonce and inode).
    try {
      linkSync(aside, path);
    } catch {
      // the path was taken again; the displaced holder's release is a no-op
    }
  }
  try {
    unlinkSync(aside);
  } catch {
    // already gone
  }
}

function processAlive(holder: string): boolean {
  const pid = Number(holder.split(":")[0]);
  // Empty or unparseable: possibly a lock being written right now — let
  // only its age decide.
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function releaseIfOurs(path: string, token: string): void {
  try {
    if (readFileSync(path, "utf-8") === token) unlinkSync(path);
  } catch {
    // gone or replaced — not ours any more
  }
}
