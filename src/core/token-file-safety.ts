import { chmodSync, existsSync, lstatSync, realpathSync, type Stats } from "node:fs";
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

/** chmod 0600, but never through a symlink. */
export function tightenTokenFile(path: string): void {
  const stat = lstatOrNull(path);
  if (!stat || stat.isSymbolicLink()) return;
  if ((stat.mode & 0o777) !== TOKEN_FILE_MODE) chmodSync(path, TOKEN_FILE_MODE);
}

/** True when group or others can read or write it (doctor). */
export function isExposedTokenFile(path: string): boolean {
  const stat = lstatOrNull(path);
  return stat !== null && !stat.isSymbolicLink() && (stat.mode & 0o077) !== 0;
}
