import { existsSync, readFileSync } from "node:fs";
import { pickMcpConfigPath } from "./agent-add-flow.js";
import {
  applyInjection,
  planInjection,
  isFilesystemError,
  planZeroclawInjection,
  readWiredAgentToken,
  UnsupportedConfigFormatError,
} from "./agent-config-injector.js";
import {
  buildMcpRegisterHint,
  writeMcpWrapperScript,
} from "./agent-mcp-register-hint.js";
import { buildMcpSnippet, ZEROCLAW_BUNDLE } from "./agent-mcp-snippet.js";
import {
  AGENT_TOKEN_ENV,
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
  UnsafeTokenPathError,
  writeTokenFile,
} from "./token-file-safety.js";
import type { RegisteredAgent } from "./registry.js";

// Writes an agent's MCP wiring with its identity token (#618): the foreman
// entry in the agent's config file and, for agents that register a wrapper
// script (Hermes), the wrapper. Shared by `foreman agent add`, `rewire`,
// `token rotate` and the setup wizard.

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
  const audit: AgentTokenAudit = { missing: [], stale: [], unwired: [], exposed: [] };
  for (const agent of agents) {
    if (!hasAgentToken(store, agent.id)) {
      audit.missing.push(agent.id);
      continue;
    }
    const registryId = typeof agent.metadata?.registryId === "string" ? agent.metadata.registryId : null;
    const entry = registryId ? entryFor(registryId) : null;
    if (!entry) continue;
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
  }
  return audit;
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

function writeTokenOutFile(path: string, token: string): void {
  checkTokenPath(path);
  writeTokenFile(path, `${token}\n`);
}
