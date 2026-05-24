import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";

// =============================================================================
// extractCwdFromTask — heuristic cwd extraction from agent task text
// =============================================================================
//
// Bug fix surfaced in manual QA 2026-05-24:
//
//   User → Hermes:    "...examine https://github.com/tuzlu07x/to-do-app
//                      the project path is /Users/fatih/Downloads/to-do-app"
//   Hermes → Foreman: submit_command(write, [codex, "Take over to-do-app
//                                              in /Users/fatih/Downloads/to-do-app"])
//   Drain handler:    spawnAgentTask({ entry, task, ... }) with NO cwd
//   Codex:            spawns in /Users/fatih/Projects/foreman (Foreman's cwd)
//                     → "/Users/fatih/Downloads/to-do-app is outside writable roots"
//                     → can't clone, can't edit, can't push
//
// Foreman wasn't passing cwd, so codex sandboxed itself to Foreman's
// working directory instead of the project the user actually asked
// about. This module is the small helper that scans the task text for
// an absolute path + returns the most plausible cwd. The drain handler
// uses it to seed `executeWriteDirective`'s cwd option.
//
// Heuristic rules:
//   1. Scan for absolute paths (`/...` on POSIX). Windows paths
//      (`C:\\...`) are NOT supported — Foreman is POSIX-first.
//   2. For each match, check whether the path exists. If yes:
//        - is a directory → use it
//        - is a file → use its dirname
//   3. Return the FIRST match (task text order is the user's intent).
//      Multiple plausible paths → first one wins; the user can re-issue
//      with clearer wording if they meant a different one.
//   4. No match / no existing path → return undefined. Caller falls
//      back to `process.cwd()` (current behaviour).
//
// Intentionally NOT considered:
//   - Relative paths (`./src`, `../foo`). These depend on the current
//     cwd which is exactly what we're trying to set — chicken/egg.
//   - URLs (`https://github.com/...`). Cloning + cwd-ing into a fresh
//     checkout is a richer feature (#TODO follow-up); for now if the
//     user names both a URL + a local path, the local path wins.
//   - Tilde expansion (`~/foo`). The agent's chat surface (Hermes,
//     etc.) rarely produces literal `~` — usually the path is already
//     expanded. Keep the heuristic narrow; expand later if needed.

/** Returns the most plausible existing absolute-path directory mentioned in
 *  `task`, or `undefined` when no valid directory path is found. */
export function extractCwdFromTask(task: string): string | undefined {
  if (!task) return undefined;
  for (const path of findAbsolutePaths(task)) {
    const dir = resolveToDirectory(path);
    if (dir) return dir;
  }
  return undefined;
}

/** Pull every plausible absolute path token out of free-form text.
 *  Tokenises on whitespace + common quote/bracket boundaries so we
 *  don't pick up trailing punctuation. Exposed for tests. */
export function findAbsolutePaths(task: string): string[] {
  const matches: string[] = [];
  // Match `/something/...` runs that start at a word boundary —
  // whitespace, line start, or an opening quote/bracket. The
  // lookbehind excludes `.`, `:`, `~`, alphanumerics so we don't
  // accidentally pick up the path tail of `./src`, `../foo`, or
  // `https://github.com/x`. Inside the run we allow typical filename
  // characters and strip trailing sentence punctuation downstream.
  const re = /(?<=^|[\s"'`([{])\/(?:[\w.\-+~/@]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(task)) !== null) {
    const raw = match[0];
    // Strip trailing sentence punctuation that the regex's char class
    // happened to allow (`.` is valid in filenames but also ends
    // sentences — be conservative).
    const trimmed = raw.replace(/[.,;:!?)\]}]+$/, "");
    if (trimmed.length > 1) matches.push(trimmed);
  }
  return matches;
}

/** Resolve a path token to a usable directory, or null when the path
 *  doesn't exist on disk. Files are mapped to their parent directory
 *  (codex / claude can `cd dirname` from a file reference). */
function resolveToDirectory(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const stat = statSync(path);
    if (stat.isDirectory()) return path;
    if (stat.isFile()) return dirname(path);
    return undefined;
  } catch {
    // EACCES / EPERM / etc. — bail rather than crash the drain
    // handler. The agent falls back to Foreman's cwd, same as before.
    return undefined;
  }
}
