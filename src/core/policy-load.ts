import { readFileSync } from "node:fs";
import { isNode, parse as parseYaml, parseDocument } from "yaml";
import { createInMemoryDb } from "../db/client.js";
import { EventBus, type ForemanEventMap } from "./event-bus.js";
import { invalidPatterns, PolicyEngine, type RuleConditions } from "./policy-engine.js";

// =============================================================================
// policy.yaml load errors (#657)
// =============================================================================
//
// A typo in policy.yaml used to crash `foreman start` (and every agent's
// `foreman mcp-stdio`) with a raw YAMLParseError stack. Loaders wrap the
// failure in a PolicyLoadError that says which file, which line and what
// is wrong, so each entry point can report it and stop cleanly. Nothing is
// loaded from a file that fails: the caller must not start on a policy the
// file doesn't say (fail closed). Once running, a broken edit keeps the
// last good policy instead (PolicyEngine.watchFile, #656).

export class PolicyLoadError extends Error {
  constructor(
    readonly path: string,
    /** 1-based line of the problem, when it can be placed. */
    readonly line: number | null,
    readonly detail: string,
  ) {
    super(`${path} failed to parse${line !== null ? ` (line ${line})` : ""}: ${detail}`);
    this.name = "PolicyLoadError";
  }
  /** An entry point that doesn't catch it (mcp-stdio) still prints this
   *  one line and exits 1, not a stack trace. */
  readonly foremanFriendly = true;
}

/** The file, line and one-line reason for a policy.yaml that won't load.
 *  With the file's text, a schema error is placed on its line too. */
export function toPolicyLoadError(path: string, err: unknown, text?: string): PolicyLoadError {
  if (err instanceof PolicyLoadError) return err;
  // ZodError: the first issue's path and message ("rules.0.source: Required").
  if (err !== null && typeof err === "object" && "issues" in err && Array.isArray(err.issues)) {
    const first = (err.issues as Array<{ path?: (string | number)[]; message?: string }>)[0];
    const where = first?.path && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
    const line = text !== undefined && first?.path ? lineOfPath(text, first.path) : null;
    return new PolicyLoadError(path, line, `${where}${first?.message ?? "invalid policy"}`);
  }
  const message = err instanceof Error ? err.message : String(err);
  // YAMLParseError: "<reason> at line 3, column 1:" followed by a code frame.
  const firstLine = message.split("\n")[0] ?? message;
  const linePos = (err as { linePos?: Array<{ line?: unknown }> } | null)?.linePos;
  const line = typeof linePos?.[0]?.line === "number" ? linePos[0].line : null;
  const reason = firstLine.replace(/\s+at line \d+, column \d+:?\s*$/, "").trim();
  return new PolicyLoadError(path, line, reason || "invalid YAML");
}

function isSqliteError(err: unknown): boolean {
  return (
    err instanceof Error && "code" in err && typeof err.code === "string" && err.code.startsWith("SQLITE_")
  );
}

/**
 * Load policy.yaml now, then follow it for the life of the process.
 *
 * At startup a file that doesn't load throws a PolicyLoadError (file,
 * line, reason): the caller reports it and stops, so nothing runs on a
 * policy other than the one the file says (fail closed, #657). From then
 * on the engine follows the file (#656): an edit applies on the next
 * decision, and a broken edit keeps the last good policy and is reported
 * once through `onError`. No file loads nothing, as before.
 */
export function followPolicyFile(
  policy: Pick<PolicyEngine, "loadYamlText" | "watchFile">,
  path: string,
  onError?: (message: string) => void,
): void {
  const text = readPolicyText(path);
  if (text !== null) {
    try {
      policy.loadYamlText(text);
    } catch (err) {
      // A database error while storing the rules (another process held the
      // lock) is not a problem with the file: don't report it as one.
      if (isSqliteError(err)) throw err;
      throw toPolicyLoadError(path, err, text);
    }
  }
  policy.watchFile(path, onError);
}

/** policy.yaml's text, or null when there is none. Read, not checked
 *  first, so there is no window between the check and the read. */
function readPolicyText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw toPolicyLoadError(path, err);
  }
}

/** Everything `loadFromYaml` would reject, plus rule patterns that are not
 *  valid regular expressions (they would silently never match). Checked
 *  against a throwaway in-memory database; null when the file is fine. */
export function validatePolicyText(path: string, text: string): PolicyLoadError | null {
  const { db, sqlite } = createInMemoryDb();
  try {
    try {
      new PolicyEngine(db, new EventBus<ForemanEventMap>()).loadYamlText(text);
    } catch (err) {
      return toPolicyLoadError(path, err, text);
    }
    const doc = parseYaml(text) as { rules?: Array<{ conditions?: RuleConditions }> } | null;
    for (const [i, rule] of (doc?.rules ?? []).entries()) {
      const bad = rule.conditions ? invalidPatterns(rule.conditions) : [];
      if (bad.length > 0) {
        return new PolicyLoadError(
          path,
          lineOfPath(text, ["rules", i, "conditions"]),
          `rules.${i}.conditions: not a valid regular expression: ${bad.map((p) => JSON.stringify(p)).join(", ")}`,
        );
      }
    }
    return null;
  } finally {
    sqlite.close();
  }
}

/** 1-based line of the deepest node on `path` that exists in the YAML. */
function lineOfPath(text: string, path: readonly (string | number)[]): number | null {
  try {
    const doc = parseDocument(text);
    for (let n = path.length; n > 0; n--) {
      const node = doc.getIn(path.slice(0, n), true);
      if (isNode(node) && node.range) {
        return text.slice(0, node.range[0]).split("\n").length;
      }
    }
  } catch {
    /* the reason alone is still useful */
  }
  return null;
}
