import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { pickConfigPath } from "./agent-add-flow.js";
import {
  applyInjection,
  planInjection,
  readWiredAgentToken,
  UnsupportedConfigFormatError,
} from "./agent-config-injector.js";
import {
  buildMcpRegisterHint,
  writeMcpWrapperScript,
} from "./agent-mcp-register-hint.js";
import { buildMcpSnippet } from "./agent-mcp-snippet.js";
import {
  ensureAgentToken,
  hasAgentToken,
  issueAgentToken,
  verifyAgentToken,
  type AgentTokenStore,
} from "./agent-token.js";
import type { AgentEntry } from "./registry-catalog.js";
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
}

export interface WireOptions {
  configPath?: string;
  /** Wrapper-path home (tests). */
  homeDir?: string;
}

/** Write `token` into the agent's wiring. Never logs the token. */
export function writeAgentWiring(
  agentId: string,
  entry: AgentEntry,
  token: string,
  options: WireOptions = {},
): WiringResult {
  const configPath = options.configPath ?? pickConfigPath(entry);
  let config: ConfigOutcome = "none";
  if (configPath) {
    if (!existsSync(configPath) && entry.install.requires_existing_config === true) {
      config = "missing";
    } else {
      try {
        const plan = planInjection(configPath, buildMcpSnippet(agentId, entry, token).json);
        applyInjection(configPath, plan);
        config = plan.alreadyHasForeman ? "current" : plan.replacedStale ? "replaced" : "written";
      } catch (err) {
        if (err instanceof UnsupportedConfigFormatError) {
          config = "unsupported";
        } else if (err instanceof Error && "code" in err) {
          throw err; // a filesystem error names the path, never the content
        } else {
          // Parser messages quote the file, which may hold a token.
          throw new Error(`${configPath} doesn't parse; fix it, then run 'foreman agent rewire ${agentId}'`);
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
  return { configPath, config, wrapperPath: hint?.wrapper?.path ?? null, wrapperWritten };
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
}

export interface RewireResult extends WiringResult {
  minted: boolean;
  tokenOutPath: string | null;
}

/**
 * Give `agentId` a token (its current one, or a new one when rotating or
 * when it has none) and write it into the wiring. Refuses to mint a token
 * it has nowhere to put: that would leave the agent untrusted with no way
 * to fix it short of another rewire.
 */
export function rewireAgent(
  store: AgentTokenStore,
  agentId: string,
  entry: AgentEntry | null,
  options: RewireOptions = {},
): RewireResult {
  const hadToken = hasAgentToken(store, agentId);
  const configPath = options.configPath ?? (entry ? pickConfigPath(entry) : null);
  const hasWrapper = Boolean(entry?.mcp_register_cli?.wrapper);
  if (!configPath && !hasWrapper && !options.tokenOut) {
    return { configPath: null, config: "none", wrapperPath: null, wrapperWritten: false, minted: false, tokenOutPath: null };
  }
  const token = options.rotate || !hadToken ? issueAgentToken(store, agentId) : ensureAgentToken(store, agentId);
  const minted = options.rotate === true || !hadToken;
  const wiring: WiringResult = entry
    ? writeAgentWiring(agentId, entry, token, { ...options, ...(configPath ? { configPath } : {}) })
    : { configPath: null, config: "none", wrapperPath: null, wrapperWritten: false };
  if (options.tokenOut) writeTokenFile(options.tokenOut, token);
  return { ...wiring, minted, tokenOutPath: options.tokenOut ?? null };
}

export interface AgentTokenAudit {
  /** Agents with no token: every MCP call they make runs untrusted. */
  missing: string[];
  /** Agents whose default config file wires Foreman without their current
   *  token (never rewired, or rotated since). */
  stale: string[];
}

/** Which registered agents still need `foreman agent rewire`. Only reads
 *  files; comparisons are constant-time and nothing is printed. */
export function auditAgentTokens(
  agents: ReadonlyArray<Pick<RegisteredAgent, "id" | "metadata">>,
  store: AgentTokenStore,
  entryFor: (registryId: string) => AgentEntry | null,
): AgentTokenAudit {
  const audit: AgentTokenAudit = { missing: [], stale: [] };
  for (const agent of agents) {
    if (!hasAgentToken(store, agent.id)) {
      audit.missing.push(agent.id);
      continue;
    }
    const registryId = typeof agent.metadata?.registryId === "string" ? agent.metadata.registryId : null;
    const entry = registryId ? entryFor(registryId) : null;
    const configPath = entry ? pickConfigPath(entry) : null;
    if (!configPath) continue;
    // A file with no foreman entry may mean the agent was wired elsewhere
    // (--config-path); only a foreman entry with the wrong token is stale.
    const wired = readWiredAgentToken(configPath);
    if (wired === undefined) continue;
    if (wired === null || !verifyAgentToken(store, agent.id, wired)) audit.stale.push(agent.id);
  }
  return audit;
}

/** One warning for `doctor` and `foreman start`, or null when every agent
 *  is wired with its current token. */
export function describeTokenAudit(audit: AgentTokenAudit): { message: string; remediation: string } | null {
  if (audit.missing.length === 0 && audit.stale.length === 0) return null;
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
  const one = audit.missing.length + audit.stale.length === 1 ? (audit.missing[0] ?? audit.stale[0]) : null;
  return {
    message: parts.join("; "),
    remediation:
      `Run \`foreman agent rewire ${one ?? "--all"}\`, then restart the agent${one ? "" : "s"}. ` +
      "Custom agents: `foreman agent rewire <id> --token-out <file>`.",
  };
}

function writeTokenFile(path: string, token: string): void {
  if (existsSync(path)) chmodSync(path, 0o600);
  writeFileSync(path, `${token}\n`, { encoding: "utf-8", mode: 0o600 });
  chmodSync(path, 0o600);
}
