import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { AGENT_TOKEN_ENV, AGENT_TOKEN_FILE_ENV } from "./agent-identity.js";
import { enabledServers, loadHubConfig, TOOL_SEPARATOR } from "./mcp-hub/config.js";

// =============================================================================
// Is this `mcp__foreman__…` tool really Foreman's? (#619)
// =============================================================================
//
// The PreToolUse hook skips Foreman's own MCP tools, because
// `foreman mcp-stdio` already mediates them and gating them twice would
// double-prompt. A project `.mcp.json` (or a local-scope entry in
// ~/.claude.json) can define a different server called `foreman`, and
// Claude Code prefers it over the user-scope one. Its tools would then
// skip the hook entirely. So the skip needs two things:
//   1. the tool is one Foreman actually serves, and
//   2. no config Claude Code reads defines a `foreman` server that isn't
//      `foreman mcp-stdio` from the install this hook runs from, with no
//      env beyond the agent token (isForemanWiring).
// Anything unreadable or unexpected means "gate it": a double prompt is
// the worst case, and a bypass is not an option.

/** Tools `foreman mcp-stdio` serves itself, plus the hub's meta-tools
 *  (`foreman_search_tools`, `foreman_call_tool`; not imported from hub.ts
 *  to keep the hook's start-up light). tests/cli/foreman-mcp-trust.test.ts
 *  keeps this in step with tools/list. */
export const FOREMAN_OWN_TOOLS: ReadonlySet<string> = new Set([
  "secrets/get",
  "submit_approval",
  "submit_command",
  "org_post",
  "org_read",
  "org_report",
  "org_recommend",
  "ask_user_with_options",
  "submit_user_answer",
  "submit_resolution",
  "request_action_approval",
  "foreman_search_tools",
  "foreman_call_tool",
]);

export const FOREMAN_MCP_PREFIX = "mcp__foreman__";

export interface ForemanToolContext {
  /** The session's working directory (the hook payload's `cwd`). */
  cwd: string;
  /** Path of `mcp.yaml`, for hub tools named `<server>__<tool>`. */
  hubConfigPath: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Which Foreman this hook is (tests); defaults to this process. */
  self?: ForemanSelf;
}

/** The Foreman install the hook itself runs from: an MCP server is
 *  Foreman's only if it starts this same install. */
export interface ForemanSelf {
  /** Real paths of this install's CLI entry (dist/cli/index.js) and, for
   *  a single-file build, its binary. */
  entries: ReadonlySet<string>;
  /** Real path of the Node binary running the hook. */
  node: string | null;
  /** PATH that bare commands resolve on (Claude Code's, which the hook
   *  inherits). */
  path: string;
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function currentForemanSelf(env: NodeJS.ProcessEnv = process.env): ForemanSelf {
  return foremanSelfOf({ argv1: process.argv[1], execPath: process.execPath, path: env.PATH ?? "" });
}

/** The same, for a hook process described by its script path, Node binary
 *  and PATH: the daemon decides for a hook client (#616). */
export function foremanSelfOf(proc: { argv1: string | undefined; execPath: string; path: string }): ForemanSelf {
  const entries = new Set<string>();
  const script = proc.argv1 ? realOrNull(proc.argv1) : null;
  if (script) {
    entries.add(script);
    // The fast hook (`foreman-hook`, dist/cli/hook.js) sits next to the CLI.
    if (basename(script) === "hook.js") {
      const cli = realOrNull(join(dirname(script), "index.js"));
      if (cli) entries.add(cli);
    }
  }
  const exec = realOrNull(proc.execPath);
  // A single-file build runs as the `foreman` binary itself.
  if (exec && /^foreman(\.exe)?$/i.test(basename(exec))) entries.add(exec);
  return { entries, node: exec, path: proc.path };
}

/** A bare name on PATH, or an absolute path; anything relative (which
 *  would resolve against the project) is refused, and so is a PATH with
 *  a relative (or empty) entry ahead of the match. */
function resolveCommand(command: string, path: string): string | null {
  if (isAbsolute(command)) return command;
  if (command.includes("/") || command.includes("\\")) return null;
  for (const dir of path.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) return null;
    const candidate = join(dir, command);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not in this directory
    }
  }
  return null;
}

const WIRING_KEYS: ReadonlySet<string> = new Set(["command", "args", "env", "type"]);
const WIRING_ENV_KEYS: ReadonlySet<string> = new Set([AGENT_TOKEN_ENV, AGENT_TOKEN_FILE_ENV]);

/** True only when the call can safely skip the hook. */
export function isForemanServedTool(toolName: string, ctx: ForemanToolContext): boolean {
  if (!toolName.startsWith(FOREMAN_MCP_PREFIX)) return false;
  const tool = toolName.slice(FOREMAN_MCP_PREFIX.length);
  try {
    if (!servedByForeman(tool, ctx.hubConfigPath)) return false;
    return !foremanServerOverridden({ ...ctx, self: ctx.self ?? currentForemanSelf(ctx.env ?? process.env) });
  } catch {
    return false;
  }
}

function servedByForeman(tool: string, hubConfigPath: string): boolean {
  if (FOREMAN_OWN_TOOLS.has(tool)) return true;
  const at = tool.indexOf(TOOL_SEPARATOR);
  if (at <= 0) return false;
  const server = tool.slice(0, at);
  if (!existsSync(hubConfigPath)) return false;
  return enabledServers(loadHubConfig(hubConfigPath)).some(([name]) => name === server);
}

/** True when a config Claude Code reads defines a `foreman` server that
 *  isn't Foreman's own `mcp-stdio`. Throws when a config can't be read. */
function foremanServerOverridden(ctx: ForemanToolContext & { self: ForemanSelf }): boolean {
  const env = ctx.env ?? process.env;
  const trusted = (server: unknown): boolean => isForemanWiringFor(server, ctx.self);
  const home = ctx.home ?? homedir();
  const dirs = ancestors(resolve(ctx.cwd));
  // Project scope: `.mcp.json` in the working directory or any parent.
  for (const dir of dirs) {
    const server = serverIn(join(dir, ".mcp.json"), (doc) => field(doc, "mcpServers"));
    if (server !== undefined && !trusted(server)) return true;
  }
  // User and local scope: ~/.claude.json (or under CLAUDE_CONFIG_DIR).
  const userConfigs = [join(home, ".claude.json")];
  if (env.CLAUDE_CONFIG_DIR) userConfigs.push(join(env.CLAUDE_CONFIG_DIR, ".claude.json"));
  for (const path of userConfigs) {
    const user = serverIn(path, (doc) => field(doc, "mcpServers"));
    if (user !== undefined && !trusted(user)) return true;
    for (const dir of dirs) {
      const local = serverIn(path, (doc) => field(field(field(doc, "projects"), dir), "mcpServers"));
      if (local !== undefined && !trusted(local)) return true;
    }
  }
  return false;
}

/** The `foreman` entry of the servers map `pick` finds in a JSON file;
 *  undefined when the file or the entry doesn't exist. */
function serverIn(path: string, pick: (doc: unknown) => unknown): unknown {
  if (!existsSync(path)) return undefined;
  const doc: unknown = JSON.parse(readFileSync(path, "utf-8"));
  const servers = pick(doc);
  return servers === undefined ? undefined : field(servers, "foreman");
}

function field(value: unknown, key: string): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("unexpected MCP config shape");
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

/** `foreman mcp-stdio …` or `node <foreman cli> mcp-stdio …` starting
 *  THIS Foreman install (see ForemanSelf), with no env beyond the agent
 *  token. A command is a bare name resolved on PATH or an absolute path,
 *  judged by its real path: a look-alike `foreman` elsewhere, or an env
 *  that points Foreman at another home (FOREMAN_HOME) or injects code
 *  (NODE_OPTIONS), is not Foreman's wiring. */
export function isForemanWiring(server: unknown, self: ForemanSelf = currentForemanSelf()): boolean {
  return isForemanWiringFor(server, self);
}

function isForemanWiringFor(server: unknown, self: ForemanSelf): boolean {
  if (typeof server !== "object" || server === null || Array.isArray(server)) return false;
  const record = server as Record<string, unknown>;
  if (Object.keys(record).some((key) => !WIRING_KEYS.has(key))) return false;
  const { command, args, type, env } = record;
  if (type !== undefined && type !== "stdio") return false;
  if (typeof command !== "string") return false;
  if (env !== undefined) {
    if (typeof env !== "object" || env === null || Array.isArray(env)) return false;
    for (const [key, value] of Object.entries(env)) {
      if (!WIRING_ENV_KEYS.has(key) || typeof value !== "string") return false;
    }
  }
  const list = Array.isArray(args) && args.every((a) => typeof a === "string") ? (args as string[]) : null;
  if (!list) return false;
  const resolved = resolveCommand(command, self.path);
  const real = resolved ? realOrNull(resolved) : null;
  if (!real) return false;
  if (self.entries.has(real)) return list[0] === "mcp-stdio";
  if (self.node !== null && real === self.node) {
    const entry = list[0];
    const realEntry = entry && isAbsolute(entry) ? realOrNull(entry) : null;
    return realEntry !== null && self.entries.has(realEntry) && list[1] === "mcp-stdio";
  }
  return false;
}

function ancestors(dir: string): string[] {
  const out: string[] = [];
  let current = dir;
  for (;;) {
    out.push(current);
    const parent = dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}
