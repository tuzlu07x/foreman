import { execFileSync } from "node:child_process";
import { preferredInstallCommand, type InstallSpec } from "./agent-install.js";

// =============================================================================
// Agent Node.js engine ranges (#646)
// =============================================================================
//
// Some agents need a newer Node than Foreman does. OpenClaw declares
// `engines: >=24.16.0 <25 || >=26.1.0` since v2026.9.3, while Foreman runs
// on 22.12+. The registry entry carries that range as `engines.node`; this
// module checks it before Foreman runs an installer, and `foreman doctor`
// uses it to warn about an installed agent that can't run.
//
// `semver` is not a direct dependency, so the range parser below handles the
// small subset the registry uses: comparator sets joined by `||`, each a
// whitespace-separated list of `>=`, `>`, `<=`, `<` or `=` comparators.
// Anything else is rejected, and the registry schema refuses the entry.

type Op = ">=" | ">" | "<=" | "<" | "=";

interface Triple {
  major: number;
  minor: number;
  patch: number;
}

interface Comparator {
  op: Op;
  version: Triple;
}

const COMPARATOR_RE = /^(>=|<=|>|<|=)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

/**
 * Parse `>=24.16.0 <25 || >=26.1.0` into OR-ed sets of AND-ed comparators.
 * Returns null for anything outside the supported subset. A partial version
 * (`<25`, `>=24.16`) is only accepted after `>=` or `<`, where filling the
 * missing parts with zero matches semver; `<=25` or `=24` mean something
 * else in semver, so they are rejected rather than misread.
 */
export function parseNodeRange(range: string): Comparator[][] | null {
  const sets: Comparator[][] = [];
  for (const part of range.split("||")) {
    const tokens = part.trim().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return null;
    const set: Comparator[] = [];
    for (const token of tokens) {
      const m = COMPARATOR_RE.exec(token);
      if (!m) return null;
      const op = (m[1] ?? "=") as Op;
      const partial = m[3] === undefined || m[4] === undefined;
      if (partial && op !== ">=" && op !== "<") return null;
      set.push({
        op,
        version: {
          major: Number(m[2]),
          minor: Number(m[3] ?? 0),
          patch: Number(m[4] ?? 0),
        },
      });
    }
    sets.push(set);
  }
  return sets;
}

export function isValidNodeRange(range: string): boolean {
  return parseNodeRange(range) !== null;
}

/** Parse `v24.16.0` / `24.16.0` (any pre-release or build suffix is ignored). */
export function parseNodeVersion(version: string): Triple | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function compare(a: Triple, b: Triple): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function matches(v: Triple, c: Comparator): boolean {
  const d = compare(v, c.version);
  switch (c.op) {
    case ">=":
      return d >= 0;
    case ">":
      return d > 0;
    case "<=":
      return d <= 0;
    case "<":
      return d < 0;
    case "=":
      return d === 0;
  }
}

/** True when `version` is inside `range`. An unparseable version or range
 *  returns false, so callers hold back the install instead of guessing. */
export function satisfiesNodeRange(version: string, range: string): boolean {
  const v = parseNodeVersion(version);
  const sets = parseNodeRange(range);
  if (!v || !sets) return false;
  return sets.some((set) => set.every((c) => matches(v, c)));
}

export interface InstallerNode {
  /** Version without the leading `v`, e.g. `22.12.0`. */
  version: string;
  /** `PATH` when read from `node --version`; `foreman` when that failed and
   *  we fell back to the Node running Foreman. */
  source: "PATH" | "foreman";
}

/**
 * The Node an agent install and the agent itself will run on. Foreman
 * spawns `npm` from PATH, and npm, like the agent's own bin shim, starts
 * through `#!/usr/bin/env node`, so the `node` on PATH is the one that must
 * satisfy the agent's range. It can differ from `process.versions.node`: the
 * standalone Foreman binary embeds Node 22, and nvm or Homebrew can put a
 * different Node first on PATH. Falls back to Foreman's own Node when
 * `node --version` can't be read.
 */
export function resolveInstallerNodeVersion(
  env: NodeJS.ProcessEnv = process.env,
): InstallerNode {
  try {
    const out = execFileSync("node", ["--version"], {
      env,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const v = parseNodeVersion(out);
    if (v) {
      return { version: `${v.major}.${v.minor}.${v.patch}`, source: "PATH" };
    }
  } catch {
    /* fall through to Foreman's own Node */
  }
  return { version: process.versions.node, source: "foreman" };
}

export interface NodeEngineAgent {
  name: string;
  engines?: { node?: string } | undefined;
  install: InstallSpec;
}

export interface NodeEngineMismatch {
  agentName: string;
  required: string;
  current: InstallerNode;
  /** The agent's upstream script installer, as text for the user to run
   *  themselves. Foreman never runs it on this path. Null when the entry
   *  has no script installer for this platform. */
  upstreamCommand: string | null;
}

/**
 * Null when the agent declares no Node range or the installer Node is in
 * range. `resolveNode` is only called when a range is declared, so agents
 * without one never spawn `node --version`.
 */
export function checkNodeEngine(
  entry: NodeEngineAgent,
  resolveNode: () => InstallerNode,
  platform: NodeJS.Platform = process.platform,
): NodeEngineMismatch | null {
  const required = entry.engines?.node;
  if (!required) return null;
  const current = resolveNode();
  if (satisfiesNodeRange(current.version, required)) return null;
  return {
    agentName: entry.name,
    required,
    current,
    upstreamCommand: preferredInstallCommand(
      { ...entry.install, npm: null, brew: null },
      platform,
    ),
  };
}

/** Human-readable explanation, one sentence per line, no prefix markers. */
export function describeNodeEngineMismatch(
  m: NodeEngineMismatch,
): [string, ...string[]] {
  const where =
    m.current.source === "PATH"
      ? "the node on your PATH"
      : "the Node running Foreman";
  const lines: [string, ...string[]] = [
    `${m.agentName} needs Node ${m.required}; ${where} is v${m.current.version}. Foreman did not run its installer.`,
    "Switch to a Node in that range (e.g. with nvm) and try again.",
  ];
  if (m.upstreamCommand) {
    lines.push(`Or run the upstream installer yourself: ${m.upstreamCommand}`);
  }
  return lines;
}
