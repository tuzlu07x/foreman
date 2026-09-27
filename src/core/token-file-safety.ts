import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// Where an agent identity token (#618) may be written: agent configs, the
// MCP wrapper script, a `--token-out` file. Never through a symlink (it
// could point anywhere, and chmod would follow it), and never inside a
// project's git work tree, where the file could be committed.

export const TOKEN_FILE_MODE = 0o600;

export class UnsafeTokenPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeTokenPathError";
  }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** The nearest enclosing git work tree of `dir`, or null. */
export function gitWorkTreeOf(dir: string): string | null {
  let current = resolve(dir);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** `dir` with every symlink resolved, even when its last parts don't exist
 *  yet (they are created on write): the nearest existing ancestor is
 *  resolved and the rest appended. */
export function realDir(dir: string): string {
  const missing: string[] = [];
  let current = resolve(dir);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  let real = current;
  try {
    real = realpathSync(current);
  } catch {
    // unreadable: keep the logical path
  }
  return missing.length > 0 ? join(real, ...missing) : real;
}

/**
 * Throws `UnsafeTokenPathError` when a token must not be written to `path`.
 * Returns a warning when it may, but you should check something: a git work
 * tree rooted at your home directory (a dotfiles repo) is allowed, since the
 * agents' own configs live there.
 */
export function checkTokenPath(path: string, home: string = homedir()): string | null {
  const abs = resolve(path);
  if (lstatOrNull(abs)?.isSymbolicLink()) {
    throw new UnsafeTokenPathError(
      `${abs} is a symlink; Foreman won't write an agent token through one. ` +
        "Replace it with a regular file (or pass --config-path with the real file) and rewire.",
    );
  }
  // Where the file really lands, through symlinked parents (a GNU stow
  // layout: ~/.hermes -> ~/dotfiles/hermes), and where it appears to.
  const homes = new Set([resolve(home), realDir(home)]);
  let atHome = false;
  for (const dir of new Set([realDir(dirname(abs)), resolve(dirname(abs))])) {
    const repo = gitWorkTreeOf(dir);
    if (repo === null) continue;
    if (!homes.has(resolve(repo))) {
      throw new UnsafeTokenPathError(
        `${abs} is inside the git work tree ${repo}, where an agent token could be committed. ` +
          "Use the agent's user-level config or a path outside the repository.",
      );
    }
    atHome = true;
  }
  if (!atHome) return null;
  return `${abs} is in the git work tree at your home directory: make sure git ignores it, since it now holds an agent token.`;
}

// Token files are opened once, without following a symlink (O_NOFOLLOW),
// and every check (regular file, owner, mode) and every change (chmod,
// truncate, write) goes through that descriptor, so nothing can be swapped
// in between a check and its use. O_NONBLOCK keeps a FIFO from hanging the
// open; it is then refused as not a regular file.
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

function openNoFollow(path: string, flags: number, mode?: number): number {
  try {
    return mode === undefined ? openSync(path, flags | NOFOLLOW | NONBLOCK) : openSync(path, flags | NOFOLLOW | NONBLOCK, mode);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      throw new UnsafeTokenPathError(`${path} is a symlink, not a regular file; Foreman won't follow it for an agent token.`);
    }
    throw err;
  }
}

/** The descriptor's file must be a regular file owned by this user. */
function checkOwnedRegularFile(fd: number, path: string): Stats {
  const stat = fstatSync(fd);
  if (!stat.isFile()) throw new UnsafeTokenPathError(`${path} is not a regular file.`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new UnsafeTokenPathError(`${path} belongs to another user; Foreman won't use it for an agent token.`);
  }
  return stat;
}

/** Read a token-bearing file: no symlink, a regular file you own and, with
 *  `private`, readable only by you. Throws `UnsafeTokenPathError`. */
export function readTokenFile(path: string, opts: { private: boolean }): string {
  const fd = openNoFollow(path, fsConstants.O_RDONLY);
  try {
    const stat = checkOwnedRegularFile(fd, path);
    if (opts.private && (stat.mode & 0o077) !== 0) {
      throw new UnsafeTokenPathError(`${path} is readable by others; chmod 600 it.`);
    }
    return readFileSync(fd, "utf-8");
  } finally {
    closeSync(fd);
  }
}

/** Create or replace a token-bearing file's content: no symlink, only a
 *  regular file you own, made `mode` before the content lands. */
export function writeTokenFile(path: string, content: string, mode: number = TOKEN_FILE_MODE): void {
  const fd = openNoFollow(path, fsConstants.O_WRONLY | fsConstants.O_CREAT, mode);
  try {
    checkOwnedRegularFile(fd, path);
    fchmodSync(fd, mode);
    ftruncateSync(fd, 0);
    writeFileSync(fd, content, "utf-8");
  } finally {
    closeSync(fd);
  }
}

/** chmod to `mode` (0600 by default) through the file's own descriptor:
 *  never through a symlink, never someone else's file. */
export function tightenTokenFile(path: string, mode: number = TOKEN_FILE_MODE): void {
  let fd: number;
  try {
    fd = openNoFollow(path, fsConstants.O_RDONLY);
  } catch {
    return; // missing, or a symlink: nothing of ours to tighten
  }
  try {
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) return;
    if ((stat.mode & 0o777) !== mode) fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

/** True when group or others can read or write it (doctor). */
export function isExposedTokenFile(path: string): boolean {
  const stat = lstatOrNull(path);
  return stat !== null && !stat.isSymbolicLink() && (stat.mode & 0o077) !== 0;
}
