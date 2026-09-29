import { isInstance, supportsInstances } from "./agent-instance.js";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { pickMcpConfigPath } from "./agent-add-flow.js";
import {
  applyInjection,
  planInjection,
  ConfigParseError,
  ConfigShapeError,
  hasConfigComments,
  isFilesystemError,
  planUnwire,
  planZeroclawInjection,
  readWiredAgentToken,
  UnsupportedConfigFormatError,
  writeConfigAtomically,
} from "./agent-config-injector.js";
import { stripForemanHooks, type ClaudeSettings } from "./agent-hook.js";
import { resolveAgentSettingsPath } from "./agent-permissions.js";
import {
  buildMcpRegisterHint,
  writeMcpWrapperScript,
} from "./agent-mcp-register-hint.js";
import { buildMcpSnippet, ZEROCLAW_BUNDLE } from "./agent-mcp-snippet.js";
import {
  AGENT_TOKEN_ENV,
  AGENT_TOKEN_FILE_ENV,
  ensureAgentToken,
  hasAgentToken,
  issueAgentToken,
  verifyAgentToken,
  type AgentTokenStore,
} from "./agent-token.js";
import type { AgentEntry } from "./registry-catalog.js";
import {
  checkTokenPath,
  isExposedTokenFile,
  readTokenFile,
  UnsafeTokenPathError,
  writeTokenFile,
} from "./token-file-safety.js";
import type { RegisteredAgent } from "./registry.js";

// Writes an agent's MCP wiring with its identity token (#618): the foreman
// entry in the agent's config file and, for agents that register a wrapper
// script (Hermes), the wrapper. Shared by `foreman agent add`, `rewire`,
// `token rotate` and the setup wizard. `unwireAgent` takes it back out
// when the agent is removed.

export type ConfigOutcome =
  | "written"
  | "replaced"
  | "current"
  | "missing"
  | "unsupported"
  | "none";

export interface WiringResult {
  configPath: string | null;
  config: ConfigOutcome;
  wrapperPath: string | null;
  wrapperWritten: boolean;
  /** Something the user still has to do, e.g. no ZeroClaw agent alias to
   *  grant the foreman bundle to. */
  note?: string;
}

export interface WireOptions {
  configPath?: string;
  /** Wrapper-path home (tests). */
  homeDir?: string;
}

export class WiringParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WiringParseError";
  }
}

/** A wiring error's message when it is known not to quote file content
 *  (which may hold a token): ours, or a filesystem error naming a path. */
export function describeWiringError(err: unknown): string {
  if (err instanceof WiringParseError || err instanceof UnsafeTokenPathError) return err.message;
  if (isFilesystemError(err)) return err.message;
  // SQLite's messages ("database is locked") never carry stored values.
  if (err instanceof Error && err.name === "SqliteError") return `Foreman's database: ${err.message}`;
  return "the agent's MCP config could not be updated";
}

/** Write `token` into the agent's wiring. Never logs the token. */
export function writeAgentWiring(
  agentId: string,
  entry: AgentEntry,
  token: string,
  options: WireOptions = {},
): WiringResult {
  const configPath = options.configPath ?? pickMcpConfigPath(entry);
  let config: ConfigOutcome = "none";
  let note: string | undefined;
  if (configPath) {
    if (!existsSync(configPath) && entry.install.requires_existing_config === true) {
      config = "missing";
    } else {
      try {
        const snippet = buildMcpSnippet(agentId, entry, token).json;
        const zeroclaw = entry.mcp_config?.layout === "zeroclaw" ? planZeroclawInjection(configPath, snippet) : null;
        const plan = zeroclaw ?? planInjection(configPath, snippet);
        const warning = applyInjection(configPath, plan);
        if (warning) note = warning;
        if (!plan.alreadyHasForeman && hasConfigComments(plan.before, plan.format)) {
          const lost = `${configPath}: its comments were not kept (Foreman rewrote the ${plan.format.toUpperCase()} to add its entry).`;
          note = note ? `${note} ${lost}` : lost;
        }
        if (zeroclaw && zeroclaw.grantedAgents.length === 0) {
          const grant =
            `${configPath} defines no [agents.<alias>], so no ZeroClaw agent uses Foreman yet: ` +
            `add mcp_bundles = ["${ZEROCLAW_BUNDLE}"] to your agent, then run 'foreman agent rewire ${agentId}'`;
          note = note ? `${note} ${grant}` : grant;
        }
        config = plan.alreadyHasForeman ? "current" : plan.replacedStale ? "replaced" : "written";
      } catch (err) {
        if (err instanceof UnsupportedConfigFormatError) {
          config = "unsupported";
        } else if (err instanceof ConfigShapeError) {
          throw new WiringParseError(`${err.message}; fix it, then run 'foreman agent rewire ${agentId}'`);
        } else if (err instanceof UnsafeTokenPathError || isFilesystemError(err)) {
          throw err; // a filesystem error names the path, never the content
        } else {
          // Parser messages quote the file, which may hold a token.
          throw new WiringParseError(`${configPath} doesn't parse; fix it, then run 'foreman agent rewire ${agentId}'`);
        }
      }
    }
  }
  const hint = buildMcpRegisterHint(agentId, entry, {
    token,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  });
  let wrapperWritten = false;
  if (hint?.wrapper) wrapperWritten = writeMcpWrapperScript(hint.wrapper);
  return { configPath, config, wrapperPath: hint?.wrapper?.path ?? null, wrapperWritten, ...(note ? { note } : {}) };
}

/** When the registry declares no config for the agent (generic-mcp): the
 *  wiring has to be pasted by hand. Shared by `foreman agent add` and the
 *  setup wizard so both say the same thing. */
export const NO_CONFIG_PATH_NOTE =
  "no config path declared in the registry — paste this into the agent's config manually:";

/** How to hand an agent its token when Foreman had nowhere to write it.
 *  Names the command, never the token. */
export function tokenHandoffHint(agentId: string): string {
  return (
    `get its token with 'foreman agent rewire ${agentId} --token-out <file>' and set it as ${AGENT_TOKEN_ENV}; ` +
    "without it the agent runs untrusted."
  );
}

/** Did the token reach a place the agent reads it from? */
export function wiringDelivered(result: WiringResult): boolean {
  return (
    result.config === "written" ||
    result.config === "replaced" ||
    result.config === "current" ||
    result.wrapperPath !== null
  );
}

export interface RewireOptions extends WireOptions {
  /** Mint a new token even when one exists (rotation). */
  rotate?: boolean;
  /** Also write the token to this file (0600), for wiring by hand. */
  tokenOut?: string;
  /** Called once a new token is stored (the old one is then invalid), so
   *  a caller can tell a failure before that point from one after it. */
  onTokenIssued?: () => void;
}

export interface RewireResult extends WiringResult {
  minted: boolean;
  tokenOutPath: string | null;
}

/**
 * Give `agentId` a token (its current one, or a new one when rotating or
 * when it has none) and write it into the wiring. With nowhere to write
 * it (no config, no `tokenOut`) the token is still minted and stored, so
 * `rewire <id> --token-out <file>` can hand it over later.
 */
export function rewireAgent(
  store: AgentTokenStore,
  agentId: string,
  entry: AgentEntry | null,
  options: RewireOptions = {},
): RewireResult {
  const hadToken = hasAgentToken(store, agentId);
  const configPath = options.configPath ?? (entry ? pickMcpConfigPath(entry) : null);
  const hasWrapper = Boolean(entry?.mcp_register_cli?.wrapper);
  // A rotation revokes the old token first, whatever happens next: a
  // rotation that can't deliver the new token must still cut the old one
  // off (the caller says so and how to fetch the new one).
  const minted = options.rotate === true || !hadToken;
  const token = minted ? issueAgentToken(store, agentId) : ensureAgentToken(store, agentId);
  if (minted) options.onTokenIssued?.();
  if (!configPath && !hasWrapper && !options.tokenOut) {
    return { configPath: null, config: "none", wrapperPath: null, wrapperWritten: false, minted, tokenOutPath: null };
  }
  const wiring: WiringResult = entry
    ? writeAgentWiring(agentId, entry, token, { ...options, ...(configPath ? { configPath } : {}) })
    : { configPath: null, config: "none", wrapperPath: null, wrapperWritten: false };
  if (options.tokenOut) writeTokenOutFile(options.tokenOut, token);
  return { ...wiring, minted, tokenOutPath: options.tokenOut ?? null };
}

export interface AgentTokenAudit {
  /** Agents with no token: every MCP call they make runs untrusted. */
  missing: string[];
  /** Agents whose config (or MCP wrapper) wires Foreman without their
   *  current token (never rewired, or rotated since). */
  stale: string[];
  /** Agents whose MCP config file (or wrapper) isn't there at all. */
  unwired: string[];
  /** Token-bearing files others on this machine can read. */
  exposed: string[];
  /** Agents with a token whose wiring nothing here can see: no MCP config
   *  or wrapper in the registry (generic-mcp), no registry entry, or a
   *  config without a foreman entry (wired elsewhere, e.g. --config-path).
   *  Their token may well be wired; it just isn't verified. */
  unverified: string[];
}

const WRAPPER_TOKEN_RE = new RegExp(`^export ${AGENT_TOKEN_ENV}='([A-Za-z0-9_-]+)'$`, "m");

/** Which registered agents still need `foreman agent rewire`. Only reads
 *  files; comparisons are constant-time and nothing is printed. */
export function auditAgentTokens(
  agents: ReadonlyArray<Pick<RegisteredAgent, "id" | "metadata">>,
  store: AgentTokenStore,
  entryFor: (registryId: string) => AgentEntry | null,
  options: { homeDir?: string } = {},
): AgentTokenAudit {
  const audit: AgentTokenAudit = { missing: [], stale: [], unwired: [], exposed: [], unverified: [] };
  for (const agent of agents) {
    if (!hasAgentToken(store, agent.id)) {
      audit.missing.push(agent.id);
      continue;
    }
    const registryId = typeof agent.metadata?.registryId === "string" ? agent.metadata.registryId : null;
    const entry = registryId ? entryFor(registryId) : null;
    if (!entry) {
      audit.unverified.push(agent.id);
      continue;
    }
    // A second (third, …) instance isn't wired in the agent's own config:
    // Foreman gives it its identity at each launch (agent-instance.ts).
    if (registryId !== agent.id && isInstance(agent.id, entry) && supportsInstances(entry)) continue;
    const verdicts: Array<"ok" | "stale" | "unwired"> = [];
    const configPath = pickMcpConfigPath(entry);
    if (configPath) {
      // A file with no foreman entry may mean the agent was wired elsewhere
      // (--config-path); only a foreman entry with the wrong token is stale.
      const wired = existsSync(configPath)
        ? readWiredAgentToken(configPath, buildMcpSnippet(agent.id, entry).json)
        : null;
      if (!existsSync(configPath)) verdicts.push("unwired");
      else if (wired !== undefined) {
        verdicts.push(wired !== null && verifyAgentToken(store, agent.id, wired) ? "ok" : "stale");
        if (isExposedTokenFile(configPath)) audit.exposed.push(configPath);
      }
    }
    const wrapper = buildMcpRegisterHint(agent.id, entry, options.homeDir ? { homeDir: options.homeDir } : {})?.wrapper;
    if (wrapper) {
      if (!existsSync(wrapper.path)) verdicts.push("unwired");
      else {
        let wired: string | null = null;
        try {
          wired = WRAPPER_TOKEN_RE.exec(readFileSync(wrapper.path, "utf-8"))?.[1] ?? null;
        } catch {
          wired = null;
        }
        verdicts.push(wired !== null && verifyAgentToken(store, agent.id, wired) ? "ok" : "stale");
        if (isExposedTokenFile(wrapper.path)) audit.exposed.push(wrapper.path);
      }
    }
    if (verdicts.includes("stale")) audit.stale.push(agent.id);
    else if (verdicts.includes("unwired")) audit.unwired.push(agent.id);
    else if (!verdicts.includes("ok")) audit.unverified.push(agent.id);
  }
  return audit;
}

/** Agents whose wiring was read and carries their current token. */
export function verifiedAgentCount(agentCount: number, audit: AgentTokenAudit): number {
  return (
    agentCount - audit.missing.length - audit.stale.length - audit.unwired.length - audit.unverified.length
  );
}

/** What doctor says about an agent whose wiring it can't see: not a
 *  failure, not a pass. Never includes the token. */
export function describeUnverifiedWiring(agentId: string): { message: string; remediation: string } {
  return {
    message:
      `${agentId}: token issued, wiring not visible to doctor — make sure its MCP client passes ` +
      `${AGENT_TOKEN_ENV} (or ${AGENT_TOKEN_FILE_ENV})`,
    remediation:
      `Get its token with 'foreman agent rewire ${agentId} --token-out <file>' and set it as ${AGENT_TOKEN_ENV} ` +
      `in the agent's MCP server env (or point ${AGENT_TOKEN_FILE_ENV} at the file); without it the agent runs untrusted.`,
  };
}

/** One warning for `doctor` and `foreman start`, or null when every agent
 *  is wired with its current token in owner-only files. */
export function describeTokenAudit(audit: AgentTokenAudit): { message: string; remediation: string } | null {
  const needRewire = [...audit.missing, ...audit.stale, ...audit.unwired];
  if (needRewire.length === 0 && audit.exposed.length === 0) return null;
  const parts: string[] = [];
  if (audit.missing.length > 0) {
    parts.push(
      `no identity token for ${audit.missing.join(", ")} — ${audit.missing.length === 1 ? "its" : "their"} MCP calls ` +
        "run untrusted (no agent allow rules, org role or hub servers)",
    );
  }
  if (audit.stale.length > 0) {
    parts.push(`MCP wiring without the current token for ${audit.stale.join(", ")}`);
  }
  if (audit.unwired.length > 0) {
    parts.push(`no MCP config found for ${audit.unwired.join(", ")}`);
  }
  if (audit.exposed.length > 0) {
    parts.push(`agent tokens in files others can read: ${audit.exposed.join(", ")}`);
  }
  const fixes: string[] = [];
  if (needRewire.length > 0) {
    const one = needRewire.length === 1 ? needRewire[0] : null;
    fixes.push(
      `Run \`foreman agent rewire ${one ?? "--all"}\`, then restart the agent${one ? "" : "s"}. ` +
        "Custom agents: `foreman agent rewire <id> --token-out <file>`.",
    );
  }
  if (audit.exposed.length > 0) fixes.push(`\`chmod 600\` ${audit.exposed.join(" ")} (or rewire, which does it).`);
  return { message: parts.join("; "), remediation: fixes.join(" ") };
}

export interface UnwireOptions {
  /** The agent's MCP config (default: where `rewire` writes it). */
  configPath?: string;
  /** The agent's settings file holding Foreman's PreToolUse hook
   *  (default: the registry's `config_paths`, when it is JSON). */
  settingsPath?: string;
}

export interface UnwireResult {
  /** What was taken out, e.g. `mcpServers.foreman from /home/me/.claude.json`. */
  removed: string[];
  /** What was left in place, and why. Never quotes file content. */
  notes: string[];
}

/**
 * The inverse of `writeAgentWiring` (and `foreman agent hook install`) for
 * an agent being removed: take its `foreman` MCP entry out of the agent's
 * config and, for Claude Code, Foreman's PreToolUse hook out of its
 * settings. Only Foreman's own entries for `agentId` go; other MCP servers,
 * other agents' entries and every other key stay. Best-effort: a missing,
 * unreadable or unparsable file, or a symlink (never written through), is
 * reported in `notes` and never throws. Files keep their mode and are
 * replaced in one step, like the writers do.
 */
export function unwireAgent(
  agentId: string,
  entry: AgentEntry | null,
  options: UnwireOptions = {},
): UnwireResult {
  const result: UnwireResult = { removed: [], notes: [] };
  const configPath = options.configPath ?? (entry ? pickMcpConfigPath(entry) : null);
  if (configPath) {
    rewriteOwnConfig(configPath, result, (text) => {
      const plan = planUnwire(configPath, text, agentId);
      const notes = plan.kept.map((label) => `${configPath}: left ${label} (not ${agentId}'s Foreman wiring)`);
      if (plan.removed.length > 0 && hasConfigComments(plan.before, plan.format)) {
        notes.push(
          `${configPath}: its comments were not kept (Foreman rewrote the ${plan.format.toUpperCase()} to remove its entry).`,
        );
      }
      return {
        after: plan.removed.length > 0 ? plan.after : null,
        removed: plan.removed.map((label) => `${label} from ${configPath}`),
        notes,
      };
    });
  }
  const settingsPath = options.settingsPath ?? (entry ? hookSettingsPath(entry) : null);
  if (settingsPath) {
    rewriteOwnConfig(settingsPath, result, (text) => {
      const none = { after: null, removed: [], notes: [] };
      if (text.trim().length === 0) return none;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ConfigParseError(settingsPath, "json");
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return none;
      const next = stripForemanHooks(parsed as ClaudeSettings, agentId);
      if (next === null) return none;
      return {
        after: `${JSON.stringify(next, null, 2)}\n`,
        removed: [`Foreman's PreToolUse hook from ${settingsPath}`],
        notes: [],
      };
    });
  }
  return result;
}

interface ConfigEdit {
  /** The file's new text; null leaves it as it is. */
  after: string | null;
  removed: string[];
  notes: string[];
}

/** Where `foreman agent hook install` puts the hook: the agent's JSON
 *  settings file from the registry's `config_paths`. */
function hookSettingsPath(entry: AgentEntry): string | null {
  const configPaths = entry.config_paths ?? [];
  if (configPaths.length === 0) return null;
  const path = resolveAgentSettingsPath(configPaths);
  return extname(path).toLowerCase() === ".json" ? path : null;
}

/** Read `path` (never through a symlink, only your own regular file),
 *  let `edit` say what changes, and replace it in one step with its mode
 *  kept. Its removals count only once written; every failure becomes a
 *  note. */
function rewriteOwnConfig(path: string, result: UnwireResult, edit: (text: string) => ConfigEdit): void {
  let mode: number;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      // Deciding what's Foreman's needs the content; a symlink's target
      // could be anywhere, so it is neither read nor rewritten.
      result.notes.push(
        `${path} is a symlink; Foreman left it alone (it never reads or writes through one). Remove any foreman entry in it by hand.`,
      );
      return;
    }
    mode = stat.mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // nothing to clean
    result.notes.push(`${describeUnwireError(path, err)}; nothing removed from it`);
    return;
  }
  try {
    const change = edit(readTokenFile(path, { private: false }));
    if (change.after !== null) writeConfigAtomically(path, change.after, mode);
    result.removed.push(...change.removed);
    result.notes.push(...change.notes);
  } catch (err) {
    result.notes.push(`${describeUnwireError(path, err)}; nothing removed from it`);
  }
}

/** Never a parser's own message: it may quote a token-bearing file. */
function describeUnwireError(path: string, err: unknown): string {
  if (err instanceof UnsupportedConfigFormatError) return `${path} isn't a JSON, YAML or TOML file`;
  if (err instanceof ConfigParseError || err instanceof ConfigShapeError) return err.message;
  if (err instanceof UnsafeTokenPathError || isFilesystemError(err)) return err.message;
  return `${path} could not be updated`;
}

function writeTokenOutFile(path: string, token: string): void {
  checkTokenPath(path);
  writeTokenFile(path, `${token}\n`);
}
