import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
//      `foreman mcp-stdio`.
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
}

/** True only when the call can safely skip the hook. */
export function isForemanServedTool(toolName: string, ctx: ForemanToolContext): boolean {
  if (!toolName.startsWith(FOREMAN_MCP_PREFIX)) return false;
  const tool = toolName.slice(FOREMAN_MCP_PREFIX.length);
  try {
    if (!servedByForeman(tool, ctx.hubConfigPath)) return false;
    return !foremanServerOverridden(ctx);
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
function foremanServerOverridden(ctx: ForemanToolContext): boolean {
  const env = ctx.env ?? process.env;
  const home = ctx.home ?? homedir();
  const dirs = ancestors(resolve(ctx.cwd));
  // Project scope: `.mcp.json` in the working directory or any parent.
  for (const dir of dirs) {
    const server = serverIn(join(dir, ".mcp.json"), (doc) => field(doc, "mcpServers"));
    if (server !== undefined && !isForemanWiring(server)) return true;
  }
  // User and local scope: ~/.claude.json (or under CLAUDE_CONFIG_DIR).
  const userConfigs = [join(home, ".claude.json")];
  if (env.CLAUDE_CONFIG_DIR) userConfigs.push(join(env.CLAUDE_CONFIG_DIR, ".claude.json"));
  for (const path of userConfigs) {
    const user = serverIn(path, (doc) => field(doc, "mcpServers"));
    if (user !== undefined && !isForemanWiring(user)) return true;
    for (const dir of dirs) {
      const local = serverIn(path, (doc) => field(field(field(doc, "projects"), dir), "mcpServers"));
      if (local !== undefined && !isForemanWiring(local)) return true;
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

/** `foreman mcp-stdio …`, or node running Foreman's CLI with `mcp-stdio`. */
export function isForemanWiring(server: unknown): boolean {
  if (typeof server !== "object" || server === null || Array.isArray(server)) return false;
  const { command, args, type, url } = server as Record<string, unknown>;
  if (url !== undefined || (type !== undefined && type !== "stdio")) return false;
  if (typeof command !== "string") return false;
  const list = Array.isArray(args) && args.every((a) => typeof a === "string") ? (args as string[]) : null;
  if (!list) return false;
  const exe = basename(command);
  if (exe === "foreman") return list[0] === "mcp-stdio";
  if (exe === "node" || exe === "node.exe") {
    return /(^|[/\\])(foreman-agent[/\\])?dist[/\\]cli[/\\]index\.js$/.test(list[0] ?? "") && list[1] === "mcp-stdio";
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
